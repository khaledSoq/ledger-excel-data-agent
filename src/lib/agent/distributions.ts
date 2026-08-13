import { asNumber, excessKurtosis, inferKind, matchColumn, mean, median, quantile, skewness, stdev } from "./semantics";
import type { DataRow } from "./types";

export const FAMILIES = {
  normal: {
    name: "Normal (Gaussian)",
    pdf: "f(x) = 1/(σ√(2π)) · exp(−(x−μ)² / (2σ²))",
    params: "μ = mean, σ = std",
    useWhen: "Symmetric continuous data, |skew| < 0.5, excess kurtosis near 0.",
  },
  lognormal: {
    name: "Log-normal",
    pdf: "X > 0,  ln X ~ N(μ, σ²)",
    params: "μ = mean(ln x), σ = std(ln x)",
    useWhen: "Positive, right-skewed amounts (salary, price, time-to-event).",
  },
  exponential: {
    name: "Exponential",
    pdf: "f(x) = λ e^{−λx}   (x ≥ 0)",
    params: "λ̂ = 1 / mean",
    useWhen: "Positive, CV ≈ 1, memoryless waiting times.",
  },
  gamma: {
    name: "Gamma",
    pdf: "f(x) = 1/(Γ(k) θ^k) x^{k−1} e^{−x/θ}",
    params: "k̂ = (mean/std)²,  θ̂ = variance/mean",
    useWhen: "Positive, right-skewed, more flexible than exponential.",
  },
  poisson: {
    name: "Poisson",
    pdf: "P(K=k) = e^{−λ} λ^k / k!",
    params: "λ̂ = mean",
    useWhen: "Non-negative integer counts with variance ≈ mean.",
  },
  uniform: {
    name: "Uniform",
    pdf: "f(x) = 1 / (b − a)  on [a, b]",
    params: "a = min, b = max",
    useWhen: "Flat histogram, low |skew|, negative excess kurtosis.",
  },
  empirical: {
    name: "Empirical (no parametric family)",
    pdf: "Use the sample quantiles / ECDF.",
    params: "Q1, median, Q3, min, max",
    useWhen: "Mixed, multimodal, or too little data to justify a family.",
  },
} as const;

export type FamilyKey = keyof typeof FAMILIES;

export type DistColumn = {
  column: string;
  n: number;
  moments: {
    mean: number;
    std: number;
    variance: number;
    median: number;
    skewness: number;
    excessKurtosis: number;
    cv: number | null;
    min: number;
    max: number;
    integerish: boolean;
    nonNegative: boolean;
  };
  recommended: FamilyKey;
  why: string;
  family: (typeof FAMILIES)[FamilyKey];
  fitted: Record<string, number | null>;
};

function choose(m: DistColumn["moments"]): { key: FamilyKey; why: string } {
  if (m.min === m.max) {
    return { key: "empirical", why: "No variation — report quantiles only." };
  }
  if (m.integerish && m.nonNegative && m.mean > 0) {
    const ratio = m.variance / m.mean;
    if (ratio >= 0.7 && ratio <= 1.3) {
      return {
        key: "poisson",
        why: `Non-negative integers with variance/mean = ${ratio.toFixed(2)} ≈ 1 (Poisson moment condition).`,
      };
    }
  }
  if (Math.abs(m.skewness) < 0.3 && m.excessKurtosis < -0.8) {
    return { key: "uniform", why: "Low skew and negative excess kurtosis — flatter than a Gaussian." };
  }
  if (m.nonNegative && m.skewness > 0.5) {
    if (m.cv !== null && Math.abs(m.cv - 1) <= 0.25 && m.skewness > 0.8) {
      return {
        key: "exponential",
        why: `Positive, right-skewed, CV=${m.cv.toFixed(2)} ≈ 1 — exponential moment condition.`,
      };
    }
    // Compare raw vs log skew as a cheap stand-in for Shapiro.
    return {
      key: m.skewness > 1.1 ? "lognormal" : "gamma",
      why:
        m.skewness > 1.1
          ? "Positive and strongly right-skewed; ln(x) is the usual working model (salary / size)."
          : "Positive and right-skewed; gamma is the flexible default over exponential.",
    };
  }
  if (Math.abs(m.skewness) < 0.5 && Math.abs(m.excessKurtosis) < 1) {
    return {
      key: "normal",
      why: `|skew|=${Math.abs(m.skewness).toFixed(2)}, |excess kurtosis|=${Math.abs(m.excessKurtosis).toFixed(2)}.`,
    };
  }
  return { key: "empirical", why: "Shape is mixed or heavy-tailed; keep the empirical distribution." };
}

function fitParams(key: FamilyKey, values: number[], m: DistColumn["moments"]): Record<string, number | null> {
  if (key === "normal") return { mu: m.mean, sigma: m.std };
  if (key === "lognormal") {
    const logs = values.filter((v) => v > 0).map(Math.log);
    return { muLog: mean(logs), sigmaLog: stdev(logs) };
  }
  if (key === "exponential") return { lambda: m.mean > 0 ? 1 / m.mean : null };
  if (key === "gamma")
    return {
      shapeK: m.std > 0 ? (m.mean / m.std) ** 2 : null,
      scaleTheta: m.mean ? m.variance / m.mean : null,
    };
  if (key === "poisson") return { lambda: m.mean };
  if (key === "uniform") return { a: m.min, b: m.max };
  const s = [...values].sort((a, b) => a - b);
  return { q05: quantile(s, 0.05), q25: quantile(s, 0.25), q50: quantile(s, 0.5), q75: quantile(s, 0.75), q95: quantile(s, 0.95) };
}

export function fitDistributions(rows: DataRow[], columns?: string[]): DistColumn[] {
  const allCols = rows.length ? Object.keys(rows[0] ?? {}) : [];
  const names =
    columns?.length ?? 0
      ? (columns as string[])
      : allCols.filter((c) => {
          const k = inferKind(c, rows);
          return k === "numeric_continuous" || k === "numeric_discrete";
        });
  const out: DistColumn[] = [];
  for (const raw of names) {
    const real = matchColumn(raw, allCols);
    if (!real) continue;
    const values = rows.map((r) => asNumber(r[real] ?? null)).filter((v): v is number => v !== null);
    if (values.length < 5) continue;
    const variance = stdev(values) ** 2;
    const mu = mean(values);
    const moments: DistColumn["moments"] = {
      mean: mu,
      std: stdev(values),
      variance,
      median: median(values),
      skewness: skewness(values),
      excessKurtosis: excessKurtosis(values),
      cv: mu !== 0 ? stdev(values) / mu : null,
      min: Math.min(...values),
      max: Math.max(...values),
      integerish: values.every((v) => Math.abs(v - Math.round(v)) < 1e-8),
      nonNegative: Math.min(...values) >= 0,
    };
    const { key, why } = choose(moments);
    out.push({
      column: real,
      n: values.length,
      moments,
      recommended: key,
      why,
      family: FAMILIES[key],
      fitted: fitParams(key, values, moments),
    });
  }
  return out;
}
