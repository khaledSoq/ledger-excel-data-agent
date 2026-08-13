import { inferKind, inferMeaning, isMissing, asNumber, asDate, nonNull, quantile, mean, stdev, median, skewness } from "./semantics";
import type { ColumnKind, ColumnMeta, DataRow, InspectReport } from "./types";

function dtypeOf(kind: ColumnKind, sample: unknown): string {
  if (kind === "datetime") return "datetime";
  if (kind === "boolean") return "boolean";
  if (kind.startsWith("numeric")) return typeof sample === "number" ? "number" : "numeric";
  return "string";
}

function priority(kind: ColumnKind): number {
  if (kind === "categorical" || kind === "boolean") return 1;
  if (kind === "datetime") return 2;
  if (kind === "numeric_discrete" || kind === "numeric_continuous") return 3;
  if (kind === "id") return 5;
  return 4;
}

function selectivityHint(kind: ColumnKind, nUnique: number): string {
  if (kind === "id") return "Very high selectivity — equality returns ~1 row.";
  if (kind === "categorical")
    return `${nUnique} labels. Multiple labels → use in (OR), never AND.`;
  if (kind === "boolean") return "Two-way split. Safe to AND with other dimensions.";
  if (kind === "datetime") return "Year / range filters are medium selectivity. Apply after categorical cuts.";
  if (kind.startsWith("numeric")) return "Range filters are medium selectivity. Apply after categorical / status cuts.";
  return "Inspect sample values before filtering.";
}

export function inspectRows(rows: DataRow[]): InspectReport {
  const columnNames = rows.length ? Object.keys(rows[0] ?? {}) : [];
  const n = rows.length;
  const columns: ColumnMeta[] = columnNames.map((name) => {
    const values = nonNull(rows, name);
    const kind = inferKind(name, rows);
    const nUnique = new Set(values.map((v) => String(v))).size;
    const nMissing = rows.filter((r) => isMissing(r[name] ?? null)).length;
    const uniqueRatio = n ? nUnique / n : 0;
    const meta: ColumnMeta = {
      name,
      dtype: dtypeOf(kind, values[0]),
      kind,
      meaning: inferMeaning(name, kind, nUnique),
      nUnique,
      nMissing,
      missingPct: n ? Math.round((1000 * nMissing) / n) / 10 : 0,
      uniqueRatio: Math.round(uniqueRatio * 10000) / 10000,
      sampleValues: values.slice(0, 5),
      filterPriority: priority(kind),
      selectivityHint: selectivityHint(kind, nUnique),
    };
    if (kind === "categorical" || kind === "boolean" || kind === "numeric_discrete" || nUnique <= 40) {
      const counts: Record<string, number> = {};
      for (const v of values) {
        const k = String(v);
        counts[k] = (counts[k] ?? 0) + 1;
      }
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      meta.uniqueValues = sorted.map(([k]) => k);
      meta.valueCounts = Object.fromEntries(sorted.slice(0, 40));
    }
    if (kind === "numeric_continuous" || kind === "numeric_discrete") {
      const nums = values.map(asNumber).filter((v): v is number => v !== null);
      if (nums.length) {
        const s = [...nums].sort((a, b) => a - b);
        const q1 = quantile(s, 0.25);
        const q3 = quantile(s, 0.75);
        meta.stats = {
          count: nums.length,
          min: s[0] ?? 0,
          max: s[s.length - 1] ?? 0,
          mean: mean(nums),
          median: median(nums),
          std: stdev(nums),
          q1,
          q3,
          iqr: q3 - q1,
          skew: skewness(nums),
        };
      }
    }
    if (kind === "datetime") {
      const dates = values.map(asDate).filter((v): v is Date => v !== null);
      if (dates.length) {
        const times = dates.map((d) => d.getTime());
        meta.stats = {
          min: new Date(Math.min(...times)).toISOString().slice(0, 10),
          max: new Date(Math.max(...times)).toISOString().slice(0, 10),
          n: dates.length,
        };
      }
    }
    return meta;
  });

  const dataQuality: InspectReport["dataQuality"] = [];
  for (const c of columns) {
    if (c.missingPct > 20) {
      dataQuality.push({
        column: c.name,
        issue: "high_missingness",
        detail: `${c.missingPct}% missing — filters on this column silently drop rows.`,
      });
    }
    if (n && c.nUnique === 1) {
      dataQuality.push({
        column: c.name,
        issue: "constant",
        detail: "Only one distinct value — filtering here does not change visibility.",
      });
    }
    if (c.kind === "id" && c.uniqueRatio > 0.98) {
      dataQuality.push({
        column: c.name,
        issue: "identifier",
        detail: "Nearly unique. Equality filters return at most one row.",
      });
    }
  }

  const ranked = [...columns].sort((a, b) => {
    const ka = a.kind === "categorical" || a.kind === "boolean" || a.kind === "datetime" ? 0 : 1;
    const kb = b.kind === "categorical" || b.kind === "boolean" || b.kind === "datetime" ? 0 : 1;
    return ka - kb || a.uniqueRatio - b.uniqueRatio;
  });
  const order = ranked.map((c) => c.name);

  return {
    nRows: n,
    nCols: columnNames.length,
    columns,
    columnNames,
    sampleRows: rows.slice(0, 5),
    filterStrategy: {
      recommendedFilterOrder: order,
      applyFirst: order.slice(0, 3),
      rationale:
        "Apply high-selectivity categorical / date predicates first so remaining rows stay visible, then tighten numeric ranges. Never AND multiple values of the same column — use OR / in.",
      andVsOr: {
        useAnd: "Different columns / independent dimensions.",
        useOr: "Multiple acceptable values of one column.",
        never: "AND of mutually exclusive labels on the same column.",
      },
    },
    dataQuality,
  };
}
