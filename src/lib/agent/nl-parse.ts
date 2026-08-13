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

const CROSS_AND_CUES =
  /\b(from|in|within|among|of|who are|that are|employees?|people|staff|records?|rows?)\b/i;

const STOP = new Set([
  "all", "the", "a", "an", "or", "and", "from", "in", "of", "who", "are", "is", "that",
  "only", "show", "me", "with", "where", "employees", "employee", "people", "staff",
  "records", "record", "rows", "row",
]);

function num(raw: string): number {
  return Number(String(raw).replace(/[$,]/g, ""));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findColumnsInText(text: string, columns: string[]): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  const sorted = [...columns].sort((a, b) => b.length - a.length);
  for (const col of sorted) {
    const key = col.toLowerCase();
    if (lower.includes(key) && !found.includes(col)) found.push(col);
  }
  for (const col of columns) {
    const compact = col.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (compact.length >= 3 && lower.includes(compact) && !found.includes(col)) found.push(col);
  }
  return found;
}

type LabelHit = { column: string; value: string; start: number; end: number };

function catalogLabels(report: InspectReport): Array<{ column: string; value: string }> {
  const out: Array<{ column: string; value: string }> = [];
  for (const col of report.columns) {
    if (!col.uniqueValues?.length) continue;
    if (col.kind === "id" || col.kind === "text") continue;
    if (col.uniqueValues.length > 80) continue;
    for (const value of col.uniqueValues) {
      if (!value || value.length < 2) continue;
      out.push({ column: col.name, value });
    }
  }
  out.sort((a, b) => b.value.length - a.value.length);
  return out;
}

function extractLabelHits(text: string, report: InspectReport): LabelHit[] {
  const lower = text.toLowerCase();
  const taken: Array<[number, number]> = [];
  const hits: LabelHit[] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  for (const { column, value } of catalogLabels(report)) {
    const needle = value.toLowerCase();
    const re = new RegExp(`\\b${escapeRe(needle)}\\b`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) {
      const start = m.index;
      const end = start + needle.length;
      if (overlaps(start, end)) continue;
      taken.push([start, end]);
      hits.push({ column, value, start, end });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

function groupHitsByColumn(hits: LabelHit[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const h of hits) {
    const list = map.get(h.column) ?? [];
    if (!list.includes(h.value)) list.push(h.value);
    map.set(h.column, list);
  }
  return map;
}

function conditionFor(column: string, values: string[]): FilterCondition {
  if (values.length === 1) return { column, op: "eq", value: values[0] };
  return { column, op: "in", value: values };
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

function parseNumericAndDate(text: string, report: InspectReport): Array<FilterCondition | { clarify: ClarifyQuestion }> {
  const found: Array<FilterCondition | { clarify: ClarifyQuestion }> = [];
  const columns = report.columnNames;
  const between = text.match(BETWEEN_RE);
  if (between) {
    const colHit = findColumnsInText(text.replace(between[0], ""), columns)[0];
    const col = colHit ?? findColumnsInText(text, columns)[0];
    if (!col) {
      found.push({
        clarify: {
          question: `Between ${between[1]} and ${between[2]} — which column should I apply that range to?`,
          options: report.columns.filter((c) => c.kind.startsWith("numeric") || c.kind === "datetime").map((c) => c.name),
        },
      });
    } else {
      found.push({ column: col, op: "between", value: [num(between[1]!), num(between[2]!)] });
    }
  }
  const year =
    text.match(YEAR_RE) ??
    (/\b(20\d{2}|19\d{2})\b/.test(text) && /from|in|during|year|records/i.test(text) ? text.match(YEAR_ONLY_RE) : null);
  if (year) {
    const dateCol =
      findColumnsInText(text, columns).find((c) => report.columns.find((m) => m.name === c)?.kind === "datetime") ??
      defaultDateColumn(report);
    if (!dateCol) {
      found.push({ clarify: { question: `I see the year ${year[1]}. Which date column should I use?`, options: columns } });
    } else {
      found.push({ column: dateCol, op: "year_eq", value: Number(year[1]) });
    }
  }
  const cmp = text.match(CMP_RE);
  if (cmp) {
    const word = cmp[1]!.toLowerCase();
    const rhs = cmp[2]!;
    const col = findColumnsInText(text.replace(cmp[0], ""), columns)[0] ?? findColumnsInText(text, columns)[0];
    if (!col) {
      const numeric = report.columns.filter((c) => c.kind.startsWith("numeric") || c.kind === "datetime").map((c) => c.name);
      found.push({ clarify: { question: `${cmp[1]} ${rhs} — which column?`, options: numeric } });
    } else {
      const meta = report.columns.find((c) => c.name === col);
      if (meta?.kind === "datetime" && !/^\d{4}$/.test(rhs)) {
        const op = /before|under|below|less|younger/.test(word) ? "date_before" : "date_after";
        found.push({ column: col, op, value: rhs });
      } else {
        let op: FilterCondition["op"] = "gt";
        if (/>=|at least|on or after/.test(word)) op = "gte";
        else if (/<=|at most|on or before/.test(word)) op = "lte";
        else if (/>|greater|more|older|above|over|after/.test(word)) op = "gt";
        else op = "lt";
        found.push({ column: col, op, value: num(rhs) });
      }
    }
  }
  return found;
}

function leftoverUnknownLabels(text: string, hits: LabelHit[], report: InspectReport): string[] {
  let stripped = text;
  const named = [...hits].sort((a, b) => b.start - a.start);
  for (const h of named) {
    stripped = stripped.slice(0, h.start) + " " + stripped.slice(h.end);
  }
  stripped = stripped.replace(BETWEEN_RE, " ").replace(CMP_RE, " ").replace(YEAR_RE, " ");
  const tokens = stripped
    .split(/[^a-zA-Z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP.has(t.toLowerCase()));
  const known = new Set(hits.map((h) => h.value.toLowerCase()));
  const columns = new Set(report.columnNames.map((c) => c.toLowerCase()));
  return tokens.filter((t) => !known.has(t.toLowerCase()) && !columns.has(t.toLowerCase()));
}

export function parseNaturalLanguage(prompt: string, report: InspectReport): ParseOutcome {
  const cleaned = prompt.replace(/[?!]+$/g, "").trim();
  const hits = extractLabelHits(cleaned, report);
  const byCol = groupHitsByColumn(hits);
  const extras = parseNumericAndDate(cleaned, report);
  for (const extra of extras) {
    if ("clarify" in extra) return { ok: false, clarify: extra.clarify };
  }
  const namedCols = findColumnsInText(cleaned, report.columnNames);
  if (byCol.size >= 2) {
    const unknown = leftoverUnknownLabels(cleaned, hits, report);
    const cue = CROSS_AND_CUES.test(cleaned);
    if (!cue && /\bor\b/i.test(cleaned)) {
      const dims = [...byCol.entries()].map(([col, vals]) => `${col}: ${vals.join(" / ")}`);
      return {
        ok: false,
        clarify: {
          question:
            `I can read that two ways. Did you mean (${dims.join(") AND (")}), ` +
            `or a single mixed OR across those columns?`,
          options: [dims.join(" AND "), "One mixed OR (any of those labels)", "Cancel"],
        },
        partial: {
          logic: "and",
          conditions: [...byCol.entries()].map(([col, vals]) => conditionFor(col, vals)),
        },
      };
    }
    if (unknown.length && /from|in|within/i.test(cleaned)) {
      const dept = report.columns.find((c) => /dept|department|team/i.test(c.name));
      return {
        ok: false,
        clarify: {
          question: `I don't see “${unknown[0]}” in the sheet.${dept ? ` Known ${dept.name} values: ${dept.uniqueValues?.slice(0, 10).join(", ")}.` : ""} Did you mean only the labels I recognized?`,
          options: [
            [...byCol.entries()].map(([c, v]) => `${c} in ${v.join(", ")}`).join(" AND "),
            "Cancel",
          ],
        },
        partial: {
          logic: "and",
          conditions: [...byCol.entries()].map(([col, vals]) => conditionFor(col, vals)),
        },
      };
    }
  }
  const conditions: Array<FilterCondition | FilterGroup> = [];
  for (const [col, vals] of byCol) {
    conditions.push(conditionFor(col, vals));
  }
  for (const extra of extras) {
    if (!("clarify" in extra)) conditions.push(extra);
  }
  if (!conditions.length && namedCols.length === 1) {
    const col = namedCols[0]!;
    const meta = report.columns.find((c) => c.name === col);
    const rest = cleaned
      .replace(new RegExp(col, "ig"), " ")
      .replace(/\b(is not|isn't|isnt|not in|not|!=|is|=|:|equals?|in)\b/gi, " ")
      .replace(/[.,]/g, " ")
      .trim();
    const negated = /\b(is not|isn't|isnt|not in|not|!=)\b/i.test(cleaned);
    if (rest && meta?.kind === "text") {
      conditions.push({ column: col, op: negated ? "not_contains" : "contains", value: rest });
    } else if (rest && meta?.kind.startsWith("numeric")) {
      const n = num(rest);
      if (Number.isFinite(n)) conditions.push({ column: col, op: negated ? "ne" : "eq", value: n });
    } else if (rest && meta?.uniqueValues?.length) {
      const mapped = valuesFor(meta, rest);
      if (mapped) conditions.push({ column: col, op: negated ? "ne" : "eq", value: mapped });
      else {
        return {
          ok: false,
          clarify: {
            question: `I don't see “${rest}” in \`${col}\`. Which value did you mean?`,
            options: meta.uniqueValues.slice(0, 12),
          },
        };
      }
    }
  }
  if (!conditions.length) {
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
  const plan: FilterGroup = { logic: "and", conditions };
  return { ok: true, plan };
}

const ANOMALY_CUES =
  /\b(anomal\w*|outlier\w*|unusual|strange|weird|odd values?|extremes?)\b/i;
const DIST_CUES =
  /\b(distribut\w*|histogram\w*|pdf|density|skew(?:ness)?|what family|which (?:distribution|family)|fit (?:a )?distribution|normal\b|poisson\b|lognormal\b|gamma\b)\b/i;
const MEANING_CUES =
  /\b(what does|meaning of|what is .+ (?:column|field|mean)|explain (?:the )?\w+|describe (?:the )?\w+ column|column mean)\b/i;
const SUMMARY_CUES =
  /\b(summar\w*|overview|insights?|how many|describe (?:the )?(?:data|results?|slice|table|filtered)|tell me about|stats?(?:istics)? of|profile (?:the )?(?:data|results?))\b/i;
const QUALITY_CUES = /\b(quality|missing(?:ness)?|duplicates?|data issues?)\b/i;
const FILTER_CUES =
  /\b(where|only (?:rows?|records?|employees?)|between|greater than|less than|above|below|older than|younger than|department is|status is|equals?|is active|is not|inactive or|on leave|show (?:me )?(?:only )?|filter (?:to|by|for)|rows? where|records? where)\b/i;

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

export function resolveColumnHint(text: string, columns: string[]): string | undefined {
  const direct = findColumnsInText(text, columns)[0];
  if (direct) return direct;
  const lower = text.toLowerCase();
  const rules: Array<[RegExp, RegExp]> = [
    [/\bsalar(?:y|ies)\b/, /salary|wage|pay|compensation|income/i],
    [/\bperformance\b/, /performance|score|rating/i],
    [/\bage\b/, /^age$|years.?old/i],
    [/\bdepartment\b/, /dept|department|team|division/i],
    [/\bstatus\b/, /status|state|stage/i],
    [/\bcity\b/, /^city$|location/i],
    [/\bhire\b/, /hire|start.?date|joined/i],
    [/\bgender\b/, /gender|sex/i],
    [/\bname\b/, /name|full.?name/i],
  ];
  for (const [cue, colRe] of rules) {
    if (!cue.test(lower)) continue;
    const hit = columns.find((c) => colRe.test(c));
    if (hit) return hit;
  }
  const tokens = lower.match(/[a-z]{3,}/g) ?? [];
  for (const tok of tokens) {
    if (["the","and","for","from","with","what","that","this","filtered","records","results","column","distribution","summarize","summary"].includes(tok)) continue;
    const hits = columns.filter((c) => c.toLowerCase().replace(/[^a-z0-9]/g, "").includes(tok));
    if (hits.length === 1) return hits[0];
  }
  return undefined;
}

export function classifyIntent(prompt: string, report: InspectReport | null): Intent {
  const t = prompt.trim();
  const lower = t.toLowerCase();
  if (/^(hi|hello|hey|help|what can you do)\b/i.test(t)) return { type: "help" };
  if (/\b(reset|clear filter|show all|original data|unfilter)\b/i.test(lower)) return { type: "reset" };
  if (ANOMALY_CUES.test(lower)) {
    const col = report ? resolveColumnHint(t, report.columnNames) : undefined;
    return { type: "anomalies", column: col };
  }
  if (DIST_CUES.test(lower)) {
    const col = report ? resolveColumnHint(t, report.columnNames) : undefined;
    return { type: "distribution", column: col };
  }
  if (MEANING_CUES.test(lower)) {
    const col = report ? resolveColumnHint(t, report.columnNames) : undefined;
    return { type: "meaning", column: col };
  }
  if (SUMMARY_CUES.test(lower)) return { type: "summary" };
  if (QUALITY_CUES.test(lower)) return { type: "quality" };
  if (FILTER_CUES.test(lower)) return { type: "filter", prompt: t };
  if (report && (findColumnsInText(t, report.columnNames).length || BETWEEN_RE.test(t) || CMP_RE.test(t))) {
    return { type: "filter", prompt: t };
  }
  if (report && extractLabelHits(t, report).length) return { type: "filter", prompt: t };
  return { type: "unknown", prompt: t };
}

export { findColumnsInText, IS_RE, extractLabelHits };
