/**
 * Open-ended analytical narrator.
 * Answers "why is the distribution like this?", free-form questions about the
 * current working set, using real computed stats — not a fixed question list.
 */

import { detectAnomalies } from "./anomalies";
import { fitDistributions } from "./distributions";
import { inspectRows } from "./inspect";
import { resolveColumnFlexible } from "./reason";
import type { DataRow, InspectReport } from "./types";

function fmt(n: number, digits = 1) {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function numVals(rows: DataRow[], col: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r[col];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) out.push(Number(v));
  }
  return out;
}

function mean(xs: number[]) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stdev(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}
function quantile(xs: number[], q: number) {
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] * (hi - pos) + s[hi] * (pos - lo);
}
function skewness(xs: number[]) {
  if (xs.length < 3) return 0;
  const m = mean(xs);
  const s = stdev(xs);
  if (s === 0) return 0;
  return xs.reduce((a, x) => a + ((x - m) / s) ** 3, 0) / xs.length;
}

/** Build a plain-language explanation of why a numeric column looks the way it does. */
export function explainWhy(
  rows: DataRow[],
  column: string,
  sourceN: number,
): string {
  const xs = numVals(rows, column);
  if (xs.length < 5) {
    return `Not enough numeric values in \`${column}\` on the current ${rows.length} rows to explain the shape.`;
  }

  const med = median(xs);
  const avg = mean(xs);
  const sd = stdev(xs);
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  const iqr = q3 - q1;
  const sk = skewness(xs);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const cv = avg !== 0 ? sd / Math.abs(avg) : 0;

  const fits = fitDistributions(rows, [column]);
  const family = fits[0]?.family.name ?? "unknown";
  const whyFit = fits[0]?.why ?? "";

  const anom = detectAnomalies(rows, [column]);
  const flagged = anom.columns.find((c) => c.column === column);
  const nFlag = flagged?.nFlagged ?? 0;

  const lines: string[] = [];
  lines.push(
    `Looking at **${column}** on the current **${rows.length}** of ${sourceN} rows:`,
  );
  lines.push("");
  lines.push(
    `Centre: median ${fmt(med)}, mean ${fmt(avg)}. Spread: IQR ${fmt(q1)}–${fmt(q3)} (width ${fmt(iqr)}), SD ${fmt(sd)}. Range ${fmt(min)} → ${fmt(max)}.`,
  );

  if (Math.abs(sk) < 0.3) {
    lines.push(
      `Skewness is near zero (${fmt(sk, 2)}), so the bulk is fairly symmetric around the centre.`,
    );
  } else if (sk > 0.8) {
    lines.push(
      `The distribution is **right-skewed** (skew ≈ ${fmt(sk, 2)}): a long upper tail pulls the mean (${fmt(avg)}) above the median (${fmt(med)}). That pattern is common for pay, size, or count-like measures where most people sit in a band and a few are much higher.`,
    );
  } else if (sk > 0.3) {
    lines.push(
      `Mild right skew (≈ ${fmt(sk, 2)}): mean sits a bit above the median. A few higher values stretch the right side without dominating the story.`,
    );
  } else if (sk < -0.8) {
    lines.push(
      `Strong **left skew** (≈ ${fmt(sk, 2)}): a lower tail pulls the mean below the median. Most mass sits high with a thinner left side.`,
    );
  } else {
    lines.push(`Mild left skew (≈ ${fmt(sk, 2)}).`);
  }

  if (cv > 0.6) {
    lines.push(
      `Coefficient of variation is high (${fmt(cv, 2)}), so values are dispersed relative to the mean — expect a wide spread and possibly mixed subgroups.`,
    );
  } else if (cv < 0.2) {
    lines.push(
      `Variation is tight relative to the mean (CV ${fmt(cv, 2)}) — the filtered group is fairly homogeneous on this measure.`,
    );
  }

  lines.push(`Best simple family under the rule set: **${family}**. ${whyFit}`);

  if (nFlag > 0 && flagged) {
    const examples = flagged.records.slice(0, 3).map((r) => String(r.value)).join(", ");
    lines.push(
      `${nFlag} value(s) sit outside the default fence (${flagged.formula.name}: \`${flagged.formula.formula}\`). Examples: ${examples}. Those points stretch the tail and can exaggerate skew.`,
    );
  } else {
    lines.push("No extreme fence breaches under the default anomaly rule — the shape is driven by the bulk, not a handful of wild points.");
  }

  if (rows.length < sourceN) {
    lines.push(
      `Remember this is the **filtered** slice (${rows.length}/${sourceN}). Selection rules can change the shape versus the full sheet — e.g. keeping only certain departments may remove high or low bands.`,
    );
  }

  lines.push("");
  lines.push("If you want, ask about another column, anomalies in detail, or a summary of the whole slice.");
  return lines.join("\n");
}

/** Free-form answer about the current working set. */
export function narrateOpen(
  prompt: string,
  rows: DataRow[],
  inspect: InspectReport,
  sourceN: number,
): string {
  const lower = prompt.toLowerCase();
  const col =
    resolveColumnFlexible(prompt, inspect.columnNames) ??
    inspect.columns.find((c) => c.kind.startsWith("numeric"))?.name;

  if (
    /\b(why|how come|what (?:drives|explains|causes)|reason|like this|looks? (?:like|this)|shape|skew|tail|spread)\b/i.test(
      lower,
    ) ||
    /\b(distribut\w*|histogram|density)\b/i.test(lower)
  ) {
    if (col) return explainWhy(rows, col, sourceN);
  }

  if (/\b(compar|versus|vs\.?|difference between)\b/i.test(lower)) {
    const nums = inspect.columns.filter((c) => c.kind.startsWith("numeric")).slice(0, 2);
    if (nums.length >= 2) {
      return (
        explainWhy(rows, nums[0].name, sourceN) +
        "\n\n---\n\n" +
        explainWhy(rows, nums[1].name, sourceN)
      );
    }
  }

  const working = rows.length === sourceN ? inspect : inspectRows(rows);
  const bits: string[] = [
    rows.length === sourceN
      ? `Working set: all **${rows.length.toLocaleString()}** source rows.`
      : `Working set: **${rows.length.toLocaleString()}** of ${sourceN.toLocaleString()} source rows (current filter applied).`,
  ];

  for (const cat of working.columns.filter((c) => c.kind === "categorical" && c.valueCounts).slice(0, 3)) {
    const top = Object.entries(cat.valueCounts!)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k} (${v})`)
      .join(", ");
    bits.push(`\`${cat.name}\` mix: ${top}.`);
  }

  for (const num of working.columns.filter((c) => c.kind.startsWith("numeric") && c.stats).slice(0, 2)) {
    const s = num.stats!;
    bits.push(
      `\`${num.name}\` median ${fmt(Number(s.median))}, mean ${fmt(Number(s.mean))}, IQR ${fmt(Number(s.q1), 0)}–${fmt(Number(s.q3), 0)}.`,
    );
  }

  bits.push("");
  if (col && working.columns.some((c) => c.name === col && c.kind.startsWith("numeric"))) {
    bits.push(explainWhy(rows, col, sourceN));
  } else {
    bits.push(
      "Ask a follow-up like \u201cwhy does SalarySAR look skewed?\u201d, \u201care there anomalies in PerformanceScore?\u201d, or \u201csummarize by Department\u201d.",
    );
  }
  return bits.join("\n");
}

/** True when the prompt is clearly asking for analysis / explanation, not a new filter. */
export function looksAnalytical(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  if (
    /\b(why|how come|what (?:drives|explains|causes)|reason for|like this|looks? (?:like|this)|shape of|skew|tail|spread|pattern|interesting|notice|think)\b/i.test(
      lower,
    )
  ) {
    return true;
  }
  if (/\b(distribut\w*|histogram|density|summar\w*|anomal\w*|outlier\w*|overview|insights?|explain|meaning|describe the)\b/i.test(lower)) {
    return true;
  }
  if (/\bfiltered (?:records?|results?|rows?|data)\b/i.test(lower)) return true;
  if (/\b(for|on|about) the (?:filtered|current)\b/i.test(lower)) return true;
  return false;
}
