import { matchColumn } from "./semantics";
import type { ClarifyQuestion, ColumnMeta, FilterCondition, FilterGroup, InspectReport } from "./types";
import { isGroup } from "./types";

export type ParseOutcome =
  | { ok: true; plan: FilterGroup }
  | { ok: false; clarify: ClarifyQuestion; partial?: FilterGroup };

const BETWEEN_RE =
  /\b(?:between|from)\s+(-?[\d,.]+)\s+(?:and|to|-|–)\s+(-?[\d,.]+)\b/i;
const CMP_RE =
  /\b(greater than or equal to|less than or equal to|at least|at most|greater than|less than|more than|older than|younger than|above|below|over|under|>=|<=|>|<|on or after|on or before|after|before)\s+(-?[\d,.]+|\d{4}-\d{2}-\d{2})\b/i;
const YEAR_RE = /\b(?:in|from|during|year)\s+(20\d{2}|19\d{2})\b/i;
const YEAR_ONLY_RE = /\b(20\d{2}|19\d{2})\b/;
const IS_RE = /\b(?:is not|isn't|isnt|not in|not|!=|is|=|:)\s+/i;

function num(raw: string): number {
  return Number(String(raw).replace(/[$,]/g, ""));
}

function findColumnsInText(text: string, columns: string[]): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  const sorted = [...columns].sort((a, b) => b.length - a.length);
  for (const col of sorted) {
    const key = col.toLowerCase();
    if (lower.includes(key) && !found.includes(col)) found.push(col);
  }
  // compact aliases
  for (const col of columns) {
    const compact = col.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (compact.length >= 3 && lower.includes(compact) && !found.includes(col)) found.push(col);
  }
  return found;
}

function splitTopLevel(text: string): { logic: "and" | "or"; parts: string[] } {
  // Protect "between X and Y" so the inner and is not a splitter.
  const protectedText = text.replace(BETWEEN_RE, (m) => m.replace(/\band\b/gi, "&&"));
  const orParts = protectedText.split(/\s+\bor\b\s+/i);
  if (orParts.length > 1) {
    return { logic: "or", parts: orParts.map((p) => p.replace(/&&/g, "and").trim()).filter(Boolean) };
  }
  const andParts = protectedText.split(/\s+\band\b\s+/i);
  return {
    logic: "and",
    parts: andParts.map((p) => p.replace(/&&/g, "and").trim()).filter(Boolean),
  };
}

function defaultDateColumn(report: InspectReport): string | null {
  return report.columns.find((c) => c.kind === "datetime")?.name ?? null;
}

function valuesFor(col: ColumnMeta | undefined, token: string): string | null {
  if (!col?.uniqueValues) return null;
  const t = token.trim().toLowerCase();
  const exact = col.uniqueValues.find((v) => v.toLowerCase() === t);
  if (exact) return exact;
  const contains = col.uniqueValues.filter((v) => v.toLowerCase().includes(t) || t.includes(v.toLowerCase()));
  return contains.length === 1 ? (contains[0] ?? null) : null;
}

function parseClause(raw: string, report: InspectReport): FilterCondition | FilterGroup | { clarify: ClarifyQuestion } | null {
  const text = raw.replace(/^(where|only|records?|rows?|employees?|with|show|me|the)\s+/i, "").trim();
  if (!text) return null;
  const columns = report.columnNames;

  // between
  const between = text.match(BETWEEN_RE);
  if (between) {
    const colHit = findColumnsInText(text.replace(between[0], ""), columns)[0];
    const col = colHit ?? findColumnsInText(text, columns)[0];
    if (!col) {
      return {
        clarify: {
          question: `Between ${between[1]} and ${between[2]} — which column should I apply that range to?`,
          options: report.columns.filter((c) => c.kind.startsWith("numeric") || c.kind === "datetime").map((c) => c.name),
        },
      };
    }
    return { column: col, op: "between", value: [num(between[1]!), num(between[2]!)] };
  }

  // year
  const year = text.match(YEAR_RE) ?? (/\b(20\d{2}|19\d{2})\b/.test(text) && /from|in|during|year|records/i.test(text)
    ? text.match(YEAR_ONLY_RE)
    : null);
  if (year) {
    const dateCol =
      findColumnsInText(text, columns).find((c) => report.columns.find((m) => m.name === c)?.kind === "datetime") ??
      defaultDateColumn(report);
    if (!dateCol) {
      return { clarify: { question: `I see the year ${year[1]}. Which date column should I use?`, options: columns } };
    }
    return { column: dateCol, op: "year_eq", value: Number(year[1]) };
  }

  // comparison
  const cmp = text.match(CMP_RE);
  if (cmp) {
    const word = cmp[1]!.toLowerCase();
    const rhs = cmp[2]!;
    const col =
      findColumnsInText(text.replace(cmp[0], ""), columns)[0] ?? findColumnsInText(text, columns)[0];
    if (!col) {
      const numeric = report.columns.filter((c) => c.kind.startsWith("numeric") || c.kind === "datetime").map((c) => c.name);
      return { clarify: { question: `${cmp[1]} ${rhs} — which column?`, options: numeric } };
    }
    const meta = report.columns.find((c) => c.name === col);
    if (meta?.kind === "datetime" && !/^\d{4}$/.test(rhs)) {
      const op =
        /before|under|below|less|younger/.test(word) ? "date_before" : "date_after";
      return { column: col, op, value: rhs };
    }
    let op: FilterCondition["op"] = "gt";
    if (/>=|at least|on or after/.test(word)) op = "gte";
    else if (/<=|at most|on or before/.test(word)) op = "lte";
    else if (/>|greater|more|older|above|over|after/.test(word)) op = "gt";
    else op = "lt";
    return { column: col, op, value: num(rhs) };
  }

  // is / equals / in
  const mentioned = findColumnsInText(text, columns);
  const col = mentioned[0];
  if (col) {
    const meta = report.columns.find((c) => c.name === col);
    const rest = text
      .replace(new RegExp(col, "ig"), " ")
      .replace(/\b(is not|isn't|isnt|not in|not|!=|is|=|:|equals?|in)\b/gi, " ")
      .replace(/[.,]/g, " ")
      .trim();
    const negated = /\b(is not|isn't|isnt|not in|not|!=)\b/i.test(text);
    if (meta?.uniqueValues?.length) {
      // multiple labels in this clause?
      const labels = meta.uniqueValues.filter((v) => text.toLowerCase().includes(v.toLowerCase()));
      if (labels.length > 1) {
        return { column: col, op: negated ? "not_in" : "in", value: labels };
      }
      if (labels.length === 1) {
        return { column: col, op: negated ? "ne" : "eq", value: labels[0] };
      }
      if (rest) {
        const mapped = valuesFor(meta, rest);
        if (mapped) return { column: col, op: negated ? "ne" : "eq", value: mapped };
        return {
          clarify: {
            question: `I don't see “${rest}” in \`${col}\`. Which value did you mean?`,
            options: meta.uniqueValues.slice(0, 12),
          },
        };
      }
    }
    if (rest && (meta?.kind === "text" || meta?.kind === "id")) {
      return { column: col, op: "contains", value: rest };
    }
    if (rest && (meta?.kind.startsWith("numeric") || false)) {
      const n = num(rest);
      if (Number.isFinite(n)) return { column: col, op: negated ? "ne" : "eq", value: n };
    }
  }

  // bare categorical value (e.g. just "Sales")
  for (const meta of report.columns) {
    if (!meta.uniqueValues) continue;
    const hits = meta.uniqueValues.filter((v) => text.toLowerCase() === v.toLowerCase() || new RegExp(`\\b${v}\\b`, "i").test(text));
    if (hits.length === 1 && text.toLowerCase().includes(hits[0]!.toLowerCase())) {
      return { column: meta.name, op: "eq", value: hits[0] };
    }
    if (hits.length > 1) {
      return { column: meta.name, op: "in", value: hits };
    }
  }

  return null;
}

function collectSameColumnAnd(plan: FilterGroup): { column: string; values: unknown[] } | null {
  const eqs = plan.conditions.filter((c): c is FilterCondition => !isGroup(c) && (c.op === "eq" || c.op === "in"));
  const byCol = new Map<string, unknown[]>();
  for (const c of eqs) {
    const list = byCol.get(c.column) ?? [];
    if (Array.isArray(c.value)) list.push(...c.value);
    else list.push(c.value);
    byCol.set(c.column, list);
  }
  for (const [column, values] of byCol) {
    const uniq = [...new Set(values.map((v) => String(v)))];
    if (uniq.length > 1 && plan.logic === "and") return { column, values: uniq };
  }
  return null;
}

export function parseNaturalLanguage(prompt: string, report: InspectReport): ParseOutcome {
  const cleaned = prompt.replace(/[?!]+$/g, "").trim();
  const { logic, parts } = splitTopLevel(cleaned);
  const conditions: Array<FilterCondition | FilterGroup> = [];

  for (const part of parts) {
    const parsed = parseClause(part, report);
    if (!parsed) continue;
    if ("clarify" in parsed) return { ok: false, clarify: parsed.clarify };
    conditions.push(parsed);
  }

  if (!conditions.length) {
    // maybe the whole string is a known column question handled elsewhere
    const maybeCol = matchColumn(cleaned, report.columnNames);
    if (maybeCol) {
      return {
        ok: false,
        clarify: {
          question: `What should I do with \`${maybeCol}\`? For example a range, a value, or an anomaly check.`,
        },
      };
    }
    return {
      ok: false,
      clarify: {
        question:
          "I couldn't map that to a filter. Name a column and a condition — e.g. “Age between 25 and 40 and Department is Sales”.",
        options: report.columnNames.slice(0, 8),
      },
    };
  }

  const plan: FilterGroup = { logic, conditions };
  const clash = collectSameColumnAnd(plan);
  if (clash) {
    return {
      ok: false,
      clarify: {
        question: `\`${clash.column}\` can't be ${clash.values.map(String).join(" AND ")} at once — that hides every row. Did you mean ${clash.values.map(String).join(" OR ")}?`,
        options: [`${clash.column} in ${clash.values.join(", ")}`, "Keep only the first value", "Cancel"],
      },
      partial: {
        logic: "and",
        conditions: [
          { column: clash.column, op: "in", value: clash.values },
          ...plan.conditions.filter((c) => isGroup(c) || c.column !== clash.column),
        ],
      },
    };
  }
  return { ok: true, plan };
}

const FILTER_CUES =
  /\b(where|only|between|greater|less|above|below|over|under|older|younger|from|in 20|status|department|filter|rows?|records?|equals?|is active|is not)\b/i;
const ANOMALY_CUES = /\b(anomal|outlier|unusual|strange|weird|odd value|extreme)\b/i;
const DIST_CUES = /\b(distribut|histogram|normal|poisson|lognormal|gamma|skew|what family|pdf|which distribution)\b/i;
const MEANING_CUES = /\b(what does|mean\??|meaning|what is .+ column|explain .+ column|describe .+ column)\b/i;
const SUMMARY_CUES = /\b(summar|overview|insight|how many|describe the data|tell me about)\b/i;
const QUALITY_CUES = /\b(quality|missing|duplicate|data issue)\b/i;

export type Intent =
  | { type: "filter"; prompt: string }
  | { type: "anomalies"; column?: string }
  | { type: "distribution"; column?: string }
  | { type: "meaning"; column?: string }
  | { type: "summary" }
  | { type: "quality" }
  | { type: "reset" }
  | { type: "help" }
  | { type: "unknown"; prompt: string };

export function classifyIntent(prompt: string, report: InspectReport | null): Intent {
  const t = prompt.trim();
  const lower = t.toLowerCase();
  if (/^(hi|hello|hey|help|what can you do)\b/i.test(t)) return { type: "help" };
  if (/\b(reset|clear filter|show all|original)\b/i.test(lower)) return { type: "reset" };
  if (ANOMALY_CUES.test(lower)) {
    const col = report ? findColumnsInText(t, report.columnNames)[0] : undefined;
    return { type: "anomalies", column: col };
  }
  if (DIST_CUES.test(lower)) {
    const col = report ? findColumnsInText(t, report.columnNames)[0] : undefined;
    return { type: "distribution", column: col };
  }
  if (MEANING_CUES.test(lower)) {
    const col = report ? findColumnsInText(t, report.columnNames)[0] : undefined;
    return { type: "meaning", column: col };
  }
  if (QUALITY_CUES.test(lower)) return { type: "quality" };
  if (FILTER_CUES.test(lower)) return { type: "filter", prompt: t };
  if (SUMMARY_CUES.test(lower)) return { type: "summary" };
  // If it mentions a known categorical value or a comparison, treat as filter.
  if (report && (findColumnsInText(t, report.columnNames).length || BETWEEN_RE.test(t) || CMP_RE.test(t))) {
    return { type: "filter", prompt: t };
  }
  return { type: "unknown", prompt: t };
}

export { findColumnsInText, IS_RE };
