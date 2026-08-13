import { asNumber, excessKurtosis, inferKind, matchColumn, mean, median, quantile, skewness, stdev } from "./semantics";
import type { DataRow } from "./types";

export const ANOMALY_FORMULAS = {
  iqr: {
    name: "Tukey IQR fences",
    formula: "IQR = Q3 − Q1; fence = Q1 − k·IQR , Q3 + k·IQR  (k = 1.5 mild, k = 3 extreme)",
    when: "Default. Small n, unknown shape, or as a second opinion next to z / MAD.",
  },
  zscore: {
    name: "Classical z-score",
    formula: "z = (x − μ) / σ   flag |z| > 3",
    when: "Bulk of the column is approximately normal and not yet contaminated.",
  },
  modified_z: {
    name: "Modified z-score (Iglewicz–Hoaglin)",
    formula: "M = 0.6745 · (x − median) / MAD   flag |M| > 3.5",
    when: "Skewed or already-contaminated numeric data. More robust than z.",
  },
  rare_category: {
    name: "Rare-category frequency",
    formula: "p̂ = n_j / n   flag p̂ < 0.01 (or n_j = 1)",
    when: "Categorical / status / department labels.",
  },
} as const;

export type AnomalyRecord = {
  rowIndex: number;
  value: string | number;
  z?: number;
  modifiedZ?: number;
  reasons: string[];
};

export type AnomalyColumn = {
  column: string;
  method: string;
  why: string;
  formula: (typeof ANOMALY_FORMULAS)[keyof typeof ANOMALY_FORMULAS];
  nFlagged: number;
  params?: Record<string, number>;
  rareLabels?: Array<{ label: string; count: number; share: number }>;
  records: AnomalyRecord[];
};

export type AnomalyReport = {
  nRowsFlagged: number;
  methodSelection: string;
  columns: AnomalyColumn[];
};

function chooseMethod(kind: string, values: number[]): string {
  if (["categorical", "boolean", "text", "id"].includes(kind)) return "rare_category";
  if (values.length < 12) return "iqr";
  const sk = Math.abs(skewness(values));
  const ku = Math.abs(excessKurtosis(values));
  if (sk < 0.5 && ku < 1) return "zscore";
  return "modified_z";
}

export function detectAnomalies(rows: DataRow[], columns?: string[]): AnomalyReport {
  const names = columns?.length ? columns : rows.length ? Object.keys(rows[0] ?? {}) : [];
  const allCols = rows.length ? Object.keys(rows[0] ?? {}) : [];
  const reports: AnomalyColumn[] = [];
  const flagged = new Set<number>();

  for (const raw of names) {
    const real = matchColumn(raw, allCols);
    if (!real) continue;
    const kind = inferKind(real, rows);
    const nums = rows
      .map((r, i) => ({ i, n: asNumber(r[real] ?? null) }))
      .filter((x): x is { i: number; n: number } => x.n !== null);
    const method = chooseMethod(kind, nums.map((x) => x.n));

    if (method === "rare_category" || ["categorical", "boolean", "text", "id"].includes(kind)) {
      const counts = new Map<string, number>();
      for (const r of rows) {
        const v = r[real];
        if (v == null || v === "") continue;
        const k = String(v);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const n = [...counts.values()].reduce((s, c) => s + c, 0) || 1;
      const rare: AnomalyColumn["rareLabels"] = [];
      for (const [label, count] of counts) {
        const share = count / n;
        if (share < 0.01 || count === 1) rare.push({ label, count, share: Math.round(share * 10000) / 10000 });
      }
      const rareSet = new Set(rare.map((r) => r.label));
      const records: AnomalyRecord[] = [];
      rows.forEach((r, i) => {
        const v = r[real];
        if (v != null && v !== "" && rareSet.has(String(v))) {
          records.push({ rowIndex: i, value: String(v), reasons: ["rare_category"] });
          flagged.add(i);
        }
      });
      reports.push({
        column: real,
        method: "rare_category",
        why: ANOMALY_FORMULAS.rare_category.when,
        formula: ANOMALY_FORMULAS.rare_category,
        nFlagged: records.length,
        rareLabels: rare,
        records: records.slice(0, 50),
      });
      continue;
    }

    if (nums.length < 4) {
      reports.push({
        column: real,
        method,
        why: "Need at least 4 numeric values.",
        formula: ANOMALY_FORMULAS.iqr,
        nFlagged: 0,
        records: [],
      });
      continue;
    }
    const values = nums.map((x) => x.n);
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const low = q1 - 1.5 * iqr;
    const high = q3 + 1.5 * iqr;
    const mu = mean(values);
    const sigma = stdev(values);
    const med = median(values);
    const mad = median(values.map((x) => Math.abs(x - med)));
    const records: AnomalyRecord[] = [];
    for (const { i, n } of nums) {
      const z = sigma > 0 ? (n - mu) / sigma : 0;
      const mz = mad > 0 ? (0.6745 * (n - med)) / mad : 0;
      const reasons: string[] = [];
      if (n < low || n > high) reasons.push("iqr");
      if (method === "zscore" && Math.abs(z) > 3) reasons.push("zscore");
      if (method === "modified_z" && Math.abs(mz) > 3.5) reasons.push("modified_z");
      if (!reasons.length) continue;
      records.push({
        rowIndex: i,
        value: n,
        z: Math.round(z * 1000) / 1000,
        modifiedZ: Math.round(mz * 1000) / 1000,
        reasons,
      });
      flagged.add(i);
    }
    records.sort((a, b) => Math.abs(b.modifiedZ ?? b.z ?? 0) - Math.abs(a.modifiedZ ?? a.z ?? 0));
    reports.push({
      column: real,
      method,
      why: ANOMALY_FORMULAS[method as keyof typeof ANOMALY_FORMULAS]?.when ?? "",
      formula: ANOMALY_FORMULAS[method as keyof typeof ANOMALY_FORMULAS] ?? ANOMALY_FORMULAS.iqr,
      nFlagged: records.length,
      params: { n: values.length, mean: mu, std: sigma, median: med, mad, q1, q3, iqr, iqrLow: low, iqrHigh: high },
      records: records.slice(0, 50),
    });
  }

  return {
    nRowsFlagged: flagged.size,
    methodSelection:
      "n<12 → IQR; |skew|<0.5 and |excess kurtosis|<1 → z-score; otherwise modified z; categorical → rare labels.",
    columns: reports,
  };
}
