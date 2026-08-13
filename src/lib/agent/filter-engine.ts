import { asDate, asNumber, matchColumn, suggestColumns } from "./semantics";
import type {
  DataRow,
  FilterCondition,
  FilterGroup,
  FilterResult,
  FilterTrace,
} from "./types";
import { isGroup } from "./types";

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

function pair(value: unknown): [unknown, unknown] {
  if (Array.isArray(value) && value.length >= 2) return [value[0], value[1]];
  throw new Error("between / year_between require a two-element [min, max] value.");
}

function eqCell(cell: unknown, value: unknown): boolean {
  if (typeof cell === "number" && typeof value === "number") return cell === value;
  if (typeof cell === "boolean") return cell === Boolean(value);
  return str(cell).toLowerCase() === str(value).toLowerCase();
}

function cellIn(cell: unknown, values: unknown[]): boolean {
  return values.some((v) => eqCell(cell, v));
}

function numCell(cell: unknown): number | null {
  return asNumber((cell as never) ?? null);
}

function dateCell(cell: unknown): Date | null {
  return asDate((cell as never) ?? null);
}

export function resolveGroup(group: FilterGroup, columns: string[]): FilterGroup {
  return {
    logic: group.logic,
    conditions: group.conditions.map((item) => {
      if (isGroup(item)) return resolveGroup(item, columns);
      const real = matchColumn(item.column, columns);
      if (!real) {
        const suggestions = suggestColumns(item.column, columns);
        const hint = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";
        throw new Error(`Unknown column '${item.column}'. Available: ${columns.join(", ")}.${hint}`);
      }
      return { ...item, column: real };
    }),
  };
}

function estimateSelectivity(rows: DataRow[], item: FilterCondition | FilterGroup): number {
  if (isGroup(item)) {
    const scores = item.conditions.map((c) => estimateSelectivity(rows, c));
    if (!scores.length) return 1;
    if (item.logic === "and") {
      return Math.max(scores.reduce((p, s) => p * Math.max(s, 1e-6), 1), 0);
    }
    return Math.min(
      1,
      1 - scores.reduce((p, s) => p * Math.max(1 - s, 0), 1),
    );
  }
  const n = Math.max(rows.length, 1);
  const uniq = new Set(rows.map((r) => str(r[item.column]))).size || 1;
  switch (item.op) {
    case "eq":
      return Math.min(1, 1 / uniq);
    case "ne":
      return Math.min(1, Math.max(0, 1 - 1 / uniq));
    case "in":
      return Math.min(1, (Array.isArray(item.value) ? item.value.length : 1) / uniq);
    case "not_in":
      return Math.min(1, Math.max(0, 1 - (Array.isArray(item.value) ? item.value.length : 1) / uniq));
    case "between":
    case "year_between":
      return 0.25;
    case "year_eq":
      return 0.2;
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "date_before":
    case "date_after":
      return 0.4;
    case "contains":
    case "starts_with":
    case "ends_with":
    case "regex":
      return 0.3;
    case "is_null":
      return rows.filter((r) => r[item.column] == null || r[item.column] === "").length / n;
    case "not_null":
      return rows.filter((r) => r[item.column] != null && r[item.column] !== "").length / n;
    default:
      return 0.5;
  }
}

function matchCondition(row: DataRow, cond: FilterCondition): boolean {
  const cell = row[cond.column];
  const { op, value } = cond;
  if (op === "is_null") return cell == null || cell === "";
  if (op === "not_null") return cell != null && cell !== "";

  if (op === "year_eq" || op === "year_between" || op === "date_before" || op === "date_after") {
    const d = dateCell(cell);
    if (!d) return false;
    if (op === "year_eq") {
      const year = Number(Array.isArray(value) ? value[0] : value);
      return d.getUTCFullYear() === year;
    }
    if (op === "year_between") {
      const [lo, hi] = pair(value);
      const y = d.getUTCFullYear();
      return y >= Number(lo) && y <= Number(hi);
    }
    const other = asDate((Array.isArray(value) ? value[0] : value) as never);
    if (!other) return false;
    if (op === "date_before") return d.getTime() < other.getTime();
    return d.getTime() > other.getTime();
  }

  if (op === "eq") return eqCell(cell, value);
  if (op === "ne") return !eqCell(cell, value);
  if (op === "in") return cellIn(cell, Array.isArray(value) ? value : [value]);
  if (op === "not_in") return !cellIn(cell, Array.isArray(value) ? value : [value]);
  if (op === "contains") return str(cell).toLowerCase().includes(str(value).toLowerCase());
  if (op === "not_contains") return !str(cell).toLowerCase().includes(str(value).toLowerCase());
  if (op === "starts_with") return str(cell).toLowerCase().startsWith(str(value).toLowerCase());
  if (op === "ends_with") return str(cell).toLowerCase().endsWith(str(value).toLowerCase());
  if (op === "regex") {
    try {
      return new RegExp(str(value), "i").test(str(cell));
    } catch {
      return false;
    }
  }
  if (op === "between") {
    const [lo, hi] = pair(value);
    const n = numCell(cell);
    if (n === null) {
      const d = dateCell(cell);
      const a = asDate(lo as never);
      const b = asDate(hi as never);
      if (!d || !a || !b) return false;
      return d.getTime() >= a.getTime() && d.getTime() <= b.getTime();
    }
    return n >= Number(lo) && n <= Number(hi);
  }
  const n = numCell(cell);
  if (n === null) return false;
  const rhs = Number(value);
  if (!Number.isFinite(rhs)) return false;
  if (op === "gt") return n > rhs;
  if (op === "gte") return n >= rhs;
  if (op === "lt") return n < rhs;
  if (op === "lte") return n <= rhs;
  return false;
}

function applyGroup(rows: DataRow[], group: FilterGroup, path: string): { rows: DataRow[]; trace: FilterTrace[] } {
  if (!group.conditions.length) return { rows, trace: [] };

  if (group.logic === "or") {
    const seen = new Set<DataRow>();
    const out: DataRow[] = [];
    const trace: FilterTrace[] = [];
    for (let i = 0; i < group.conditions.length; i += 1) {
      const item = group.conditions[i]!;
      const child = isGroup(item)
        ? applyGroup(rows, item, `${path}.or[${i}]`)
        : { rows: rows.filter((r) => matchCondition(r, item)), trace: [] as FilterTrace[] };
      let added = 0;
      for (const r of child.rows) {
        if (!seen.has(r)) {
          seen.add(r);
          out.push(r);
          added += 1;
        }
      }
      trace.push({
        path: `${path}.or[${i}]`,
        logic: "or",
        predicate: item,
        addedRows: added,
        child: child.trace,
      });
    }
    return { rows: out, trace };
  }

  const ordered = [...group.conditions].sort(
    (a, b) => estimateSelectivity(rows, a) - estimateSelectivity(rows, b),
  );
  let working = rows;
  const trace: FilterTrace[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const item = ordered[i]!;
    const before = working.length;
    const child = isGroup(item)
      ? applyGroup(working, item, `${path}.and[${i}]`)
      : { rows: working.filter((r) => matchCondition(r, item)), trace: [] as FilterTrace[] };
    working = child.rows;
    const after = working.length;
    const pred = isGroup(item) ? item : item;
    trace.push({
      path: `${path}.and[${i}]`,
      logic: "and",
      order: i + 1,
      predicate: pred,
      estimatedSelectivity: estimateSelectivity(rows, item),
      rowsBefore: before,
      rowsAfter: after,
      dropped: before - after,
      emptiedResult: before > 0 && after === 0,
      note:
        before > 0 && after === 0
          ? "This predicate removed every remaining row. Combining it with AND hid the rest of the data. Consider relaxing it or switching same-column values to OR."
          : "Applied after more selective predicates so remaining rows stay visible.",
      child: child.trace,
    });
  }
  return { rows: working, trace };
}

function humanSummary(nIn: number, nOut: number, trace: FilterTrace[]): string {
  const pct = nIn ? ((100 * nOut) / nIn).toFixed(1) : "0.0";
  const bits = [`Matched ${nOut.toLocaleString()} of ${nIn.toLocaleString()} rows (${pct}%).`];
  if (nOut === 0) bits.push("The result is empty — see the filter trace for which predicate removed the last rows.");
  const walk = (nodes: FilterTrace[]) => {
    for (const node of nodes) {
      if (node.logic === "and" && (node.dropped ?? 0) > 0 && node.predicate && !isGroup(node.predicate)) {
        const p = node.predicate;
        bits.push(
          `AND step ${node.order}: ${p.column} ${p.op} ${JSON.stringify(p.value)} dropped ${node.dropped} rows (${node.rowsBefore} → ${node.rowsAfter}).`,
        );
      }
      if (node.child?.length) walk(node.child);
    }
  };
  walk(trace);
  return bits.join(" ");
}

export function applyFilter(rows: DataRow[], plan: FilterGroup): FilterResult {
  const columns = rows.length ? Object.keys(rows[0] ?? {}) : [];
  const resolved = resolveGroup(plan, columns);
  const { rows: matched, trace } = applyGroup(rows, resolved, "root");
  return {
    rows: matched,
    nInput: rows.length,
    nMatched: matched.length,
    nDropped: rows.length - matched.length,
    plan: resolved,
    trace,
    empty: matched.length === 0,
    summary: humanSummary(rows.length, matched.length, trace),
  };
}

export function describePlan(plan: FilterGroup): string {
  const parts = plan.conditions.map((c) => {
    if (isGroup(c)) return `(${describePlan(c)})`;
    const val = Array.isArray(c.value) ? c.value.join("–") : String(c.value ?? "");
    return `${c.column} ${c.op} ${val}`.trim();
  });
  return parts.join(` ${plan.logic.toUpperCase()} `);
}
