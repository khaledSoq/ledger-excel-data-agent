import type { CellValue, ColumnKind, DataRow } from "./types";

const ID_RE = /(^id$|_id$|^id_|uuid|guid|pk$|primary.?key|employee.?id|user.?id|record.?id)/i;
const DATE_RE = /(date|time|timestamp|hired|start|end|dob|birth|created|updated|year|month)/i;
const MONEY_RE = /(salary|wage|pay|price|cost|amount|revenue|fee|budget|income|spend)/i;
const AGE_RE = /(^age$|years.?old|tenure)/i;
const STATUS_RE = /(status|state|stage|phase)/i;
const DEPT_RE = /(dept|department|team|division|org|unit|function)/i;
const EMAIL_RE = /(email|e-mail)/i;
const GEO_RE = /(city|region|country|state|province|location|office)/i;
const SCORE_RE = /(score|rating|performance|grade|rank)/i;
const COUNT_RE = /(count|qty|quantity|n_|num_|number_of|headcount)/i;

export function isMissing(v: CellValue): boolean {
  return v === null || v === undefined || v === "";
}

export function asNumber(v: CellValue): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,]/g, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asDate(v: CellValue): Date | null {
  if (v === null || v === "") return null;
  if (typeof v === "number") {
    // Excel serial date (days since 1899-12-30)
    if (v > 20000 && v < 80000) {
      const utc = Date.UTC(1899, 11, 30) + v * 86400000;
      const d = new Date(utc);
      return Number.isNaN(d.getTime()) ? null : d;
    }
  }
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function nonNull(rows: DataRow[], col: string): CellValue[] {
  return rows.map((r) => r[col] ?? null).filter((v) => !isMissing(v));
}

function uniqueCount(values: CellValue[]): number {
  return new Set(values.map((v) => String(v))).size;
}

function looksBoolean(values: CellValue[]): boolean {
  if (!values.length) return false;
  const tokens = new Set(
    ["true", "false", "yes", "no", "y", "n", "0", "1", "t", "f", "active", "inactive"],
  );
  const uniq = [...new Set(values.slice(0, 12).map((v) => String(v).trim().toLowerCase()))];
  return uniq.length <= 3 && uniq.every((u) => tokens.has(u));
}

function looksDatetime(values: CellValue[]): boolean {
  if (!values.length) return false;
  const sample = values.slice(0, 20);
  const ok = sample.filter((v) => asDate(v) !== null).length;
  return ok / sample.length >= 0.7;
}

function looksNumeric(values: CellValue[]): boolean {
  if (!values.length) return false;
  const ok = values.slice(0, 30).filter((v) => asNumber(v) !== null).length;
  return ok / Math.min(values.length, 30) >= 0.8;
}

export function inferKind(name: string, rows: DataRow[]): ColumnKind {
  const values = nonNull(rows, name);
  const n = rows.length;
  const nUnique = uniqueCount(values);
  const uniqueRatio = n ? nUnique / n : 0;
  if ((ID_RE.test(name) || /id$/i.test(name)) && uniqueRatio > 0.9) return "id";
  if (looksBoolean(values)) return "boolean";
  if (DATE_RE.test(name) && looksDatetime(values)) return "datetime";
  if (looksDatetime(values) && !looksNumeric(values)) return "datetime";
  if (looksNumeric(values)) {
    if (nUnique <= 2 && values.every((v) => [0, 1, "0", "1", true, false].includes(v as never))) {
      return "boolean";
    }
    if (nUnique <= 40 && uniqueRatio <= 0.16) return "numeric_discrete";
    return "numeric_continuous";
  }
  if (nUnique <= 40 || uniqueRatio <= 0.08) return "categorical";
  return "text";
}

export function inferMeaning(name: string, kind: ColumnKind, nUnique: number): string {
  if (AGE_RE.test(name)) return "Age in years — numeric range filters (between / gt / lt).";
  if (MONEY_RE.test(name)) return "Monetary amount — compare with gt / lt / between. Watch outliers.";
  if (STATUS_RE.test(name)) return "Lifecycle / status flag — categorical. Prefer eq / in, never range math.";
  if (DEPT_RE.test(name))
    return "Organizational grouping — categorical. Multiple values use OR / in, not AND.";
  if (EMAIL_RE.test(name)) return "Email address — high-cardinality text. Use contains / eq.";
  if (GEO_RE.test(name)) return "Geographic dimension — categorical. Combine with other columns using AND.";
  if (SCORE_RE.test(name)) return "Score / rating — range filters and anomaly checks apply.";
  if (COUNT_RE.test(name)) return "Count / quantity — discrete numeric. Poisson is often a good model.";
  if (kind === "datetime") return "Date / time — use year_eq, date_before, date_after, or between.";
  if (kind === "id") return "Identifier — nearly unique. Equality returns at most one record.";
  if (kind === "boolean") return "Boolean flag — eq with the column's native labels.";
  if (kind === "categorical") return `Categorical field with ${nUnique} distinct values. Use eq / in / not_in.`;
  if (kind === "numeric_continuous") return "Continuous numeric measure — range filters and distribution tools apply.";
  if (kind === "numeric_discrete") return "Low-cardinality numeric. Prefer in / eq over wide ranges.";
  if (kind === "text") return "Free text — use contains / starts_with. Do not treat as numeric.";
  return "Inspect sample values before filtering.";
}

export function matchColumn(requested: string, columns: string[]): string | null {
  const req = requested.trim();
  if (!req) return null;
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  if (columns.includes(req)) return req;
  const hit = lower.get(req.toLowerCase());
  if (hit) return hit;
  const compact = req.toLowerCase().replace(/[^a-z0-9]/g, "");
  const compactHits = columns.filter((c) => c.toLowerCase().replace(/[^a-z0-9]/g, "") === compact);
  if (compactHits.length === 1) return compactHits[0] ?? null;
  const contains = columns.filter((c) => compact && c.toLowerCase().replace(/[^a-z0-9]/g, "").includes(compact));
  if (contains.length === 1) return contains[0] ?? null;
  const prefixes = columns.filter((c) => c.toLowerCase().startsWith(req.toLowerCase()));
  if (prefixes.length === 1) return prefixes[0] ?? null;
  return null;
}

export function suggestColumns(requested: string, columns: string[], limit = 5): string[] {
  const req = (requested || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return columns
    .map((c) => {
      const key = c.toLowerCase().replace(/[^a-z0-9]/g, "");
      let score = 0;
      if (req && key.includes(req)) score += 4;
      if (key.startsWith(req)) score += 3;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.c);
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = sorted[base] ?? 0;
  const b = sorted[base + 1] ?? a;
  return a + rest * (b - a);
}

export function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const v = values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(v);
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return quantile(s, 0.5);
}

export function skewness(values: number[]): number {
  const n = values.length;
  if (n < 3) return 0;
  const m = mean(values);
  const s = stdev(values);
  if (s === 0) return 0;
  const m3 = values.reduce((acc, x) => acc + (x - m) ** 3, 0) / n;
  return m3 / s ** 3;
}

export function excessKurtosis(values: number[]): number {
  const n = values.length;
  if (n < 4) return 0;
  const m = mean(values);
  const s = stdev(values);
  if (s === 0) return 0;
  const m4 = values.reduce((acc, x) => acc + (x - m) ** 4, 0) / n;
  return m4 / s ** 4 - 3;
}
