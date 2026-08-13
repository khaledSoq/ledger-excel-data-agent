/**
 * Agentic intent reasoner — multi-signal scoring + optional local Ollama.
 * Tools still execute deterministically; the reasoner only decides *what* to do.
 */

import type { InspectReport } from "./types";
import { extractLabelHits, findColumnsInText, resolveColumnHint, type Intent } from "./nl-parse";

export type ReasonedIntent = Intent & {
  rationale: string;
  confidence: number;
  source: "scored" | "ollama";
};

type Score = { intent: Intent; score: number; reasons: string[] };

function compact(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Match headers even when the user types performancescore / salarysar. */
export function resolveColumnFlexible(text: string, columns: string[]): string | undefined {
  const hinted = resolveColumnHint(text, columns);
  if (hinted) return hinted;
  const direct = findColumnsInText(text, columns)[0];
  if (direct) return direct;

  const blob = compact(text);
  const ranked = columns
    .map((c) => {
      const key = compact(c);
      let score = 0;
      if (blob.includes(key) && key.length >= 3) score += key.length + 5;
      if (key.includes("performance") && /performance/.test(blob)) score += 8;
      if (key.includes("salary") && /salar/.test(blob)) score += 8;
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.c;
}

/**
 * Score every plausible intent; pick the winner.
 * Analytical signals beat filter signals when both fire (e.g. "distribution … filtered records").
 */
export function reasonIntent(prompt: string, report: InspectReport | null): ReasonedIntent {
  const t = prompt.trim();
  const lower = t.toLowerCase();
  const columns = report?.columnNames ?? [];
  const col = report ? resolveColumnFlexible(t, columns) : undefined;

  if (/^(hi|hello|hey|help|what can you do)\b/i.test(t)) {
    return { type: "help", rationale: "Greeting / help request.", confidence: 1, source: "scored" };
  }
  if (/\b(reset|clear filter|show all|original data|unfilter)\b/i.test(lower)) {
    return { type: "reset", rationale: "User asked to clear the filter.", confidence: 1, source: "scored" };
  }

  const scores: Score[] = [];

  const distHits =
    (/\bdistribut/i.test(lower) ? 6 : 0) +
    (/\bhistogram\b/i.test(lower) ? 5 : 0) +
    (/\b(pdf|density|skew|normal|poisson|lognormal|gamma)\b/i.test(lower) ? 3 : 0) +
    (/\bfit (?:a )?distribution\b/i.test(lower) ? 6 : 0);
  if (distHits) {
    scores.push({
      intent: { type: "distribution", column: col },
      score: distHits + (col ? 2 : 0),
      reasons: [
        "Mentions distribution / density language",
        col ? `Column candidate: ${col}` : "No specific column — will scan numerics",
      ],
    });
  }

  const sumHits =
    (/\bsummar/i.test(lower) ? 6 : 0) +
    (/\b(overview|insights?|how many)\b/i.test(lower) ? 4 : 0) +
    (/\bdescribe (?:the )?(?:data|results?|slice|table|filtered)\b/i.test(lower) ? 5 : 0) +
    (/\btell me about\b/i.test(lower) ? 3 : 0) +
    (/\bstats?(?:istics)?\b/i.test(lower) ? 3 : 0);
  if (sumHits) {
    scores.push({
      intent: { type: "summary" },
      score: sumHits,
      reasons: ["Asks for a summary / overview of the working set"],
    });
  }

  const anomHits =
    (/\banomal/i.test(lower) ? 6 : 0) +
    (/\boutlier/i.test(lower) ? 5 : 0) +
    (/\b(unusual|strange|weird|extreme)\b/i.test(lower) ? 3 : 0);
  if (anomHits) {
    scores.push({
      intent: { type: "anomalies", column: col },
      score: anomHits + (col ? 2 : 0),
      reasons: ["Asks about anomalies / outliers", col ? `Column candidate: ${col}` : "Will scan measurable columns"],
    });
  }

  const meanHits =
    (/\bwhat does\b/i.test(lower) ? 5 : 0) +
    (/\bmeaning\b/i.test(lower) ? 5 : 0) +
    (/\bexplain\b/i.test(lower) ? 4 : 0) +
    (/\bcolumn mean\b/i.test(lower) ? 4 : 0) +
    (/\bwhat is .+ (?:column|field)\b/i.test(lower) ? 5 : 0);
  if (meanHits) {
    scores.push({
      intent: { type: "meaning", column: col },
      score: meanHits + (col ? 2 : 0),
      reasons: ["Asks what a column means / for an explanation"],
    });
  }

  const qualHits =
    (/\bquality\b/i.test(lower) ? 4 : 0) +
    (/\bmissing\b/i.test(lower) ? 3 : 0) +
    (/\bduplicates?\b/i.test(lower) ? 3 : 0);
  if (qualHits) {
    scores.push({
      intent: { type: "quality" },
      score: qualHits,
      reasons: ["Asks about data quality"],
    });
  }

  const filterHits =
    (/\bbetween\b/i.test(lower) ? 5 : 0) +
    (/\b(greater than|less than|older than|younger than|at least|at most)\b/i.test(lower) ? 5 : 0) +
    (/\b(above|below|over|under)\s+\d/i.test(lower) ? 4 : 0) +
    (/\b(department is|status is|equals?)\b/i.test(lower) ? 4 : 0) +
    (/\b(only (?:rows?|records?|employees?)|rows? where|records? where|filter (?:to|by|for))\b/i.test(lower) ? 5 : 0) +
    (/\b(inactive|on leave|active)\b/i.test(lower) && /\b(from|in|department|finance|hr|sales|engineering)\b/i.test(lower) ? 5 : 0) +
    (/\b(where|show (?:me )?(?:only )?)\b/i.test(lower) ? 2 : 0);

  const refersToCurrentSlice = /\bfiltered\b/i.test(lower) || /\bcurrent (?:result|slice|set|data)\b/i.test(lower);

  if (filterHits && !refersToCurrentSlice) {
    scores.push({
      intent: { type: "filter", prompt: t },
      score: filterHits,
      reasons: ["Looks like a row-selection / filter request"],
    });
  } else if (filterHits && refersToCurrentSlice && !distHits && !sumHits && !anomHits && !meanHits) {
    scores.push({
      intent: { type: "filter", prompt: t },
      score: filterHits - 2,
      reasons: ["Filter-like language present"],
    });
  }

  if (report && !distHits && !sumHits && !anomHits && !meanHits) {
    const hits = extractLabelHits(t, report);
    if (hits.length >= 1) {
      scores.push({
        intent: { type: "filter", prompt: t },
        score: 3 + Math.min(hits.length, 3),
        reasons: [`Recognized ${hits.length} known value(s) in the sheet`],
      });
    } else if (findColumnsInText(t, columns).length || col) {
      if (/\b(is|equals?|between|from|in|only|where|active|inactive)\b/i.test(lower)) {
        scores.push({
          intent: { type: "filter", prompt: t },
          score: 3,
          reasons: ["Mentions known columns / values with selection language"],
        });
      }
    }
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  if (!best || best.score < 2) {
    return {
      type: "unknown",
      prompt: t,
      rationale: "No clear analytical or filter signal.",
      confidence: 0.2,
      source: "scored",
    };
  }

  if (
    best.intent.type === "filter" &&
    scores.some((s) => s.intent.type !== "filter" && s.score >= 4)
  ) {
    const alt = scores.find((s) => s.intent.type !== "filter")!;
    return {
      ...alt.intent,
      rationale: `Reasoned: ${alt.reasons.join("; ")} (preferred over filter).`,
      confidence: Math.min(1, alt.score / 10),
      source: "scored",
    };
  }

  return {
    ...best.intent,
    rationale: `Reasoned: ${best.reasons.join("; ")}.`,
    confidence: Math.min(1, best.score / 10),
    source: "scored",
  };
}

export type OllamaPlan = {
  action: "filter" | "summary" | "distribution" | "anomalies" | "meaning" | "quality" | "reset" | "help" | "unknown";
  column?: string;
  filter_prompt?: string;
  rationale?: string;
};

export async function reasonWithOllama(
  prompt: string,
  report: InspectReport,
  opts?: { baseUrl?: string; model?: string },
): Promise<ReasonedIntent | null> {
  const base = (opts?.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
  const model = opts?.model ?? "llama3.2:3b";
  const system = `You are the planner for a spreadsheet agent. Given column names and a user message, reply with ONLY compact JSON:
{"action":"summary|distribution|anomalies|meaning|quality|filter|reset|help|unknown","column":"optional exact column name","filter_prompt":"optional restated filter","rationale":"one short sentence"}
Rules:
- If the user asks to summarize, describe, or overview the current/filtered data → summary
- If they ask about distribution, histogram, density, skew → distribution
- If they ask about anomalies/outliers → anomalies
- If they ask what a column means → meaning
- If they ask to select/filter rows → filter
- Prefer action over guessing. Never invent column names; pick from the list or omit column.
Columns: ${report.columnNames.join(", ")}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        options: { temperature: 0.1 },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { message?: { content?: string } };
    const raw = body.message?.content ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const plan = JSON.parse(jsonMatch[0]) as OllamaPlan;
    const col =
      plan.column && report.columnNames.includes(plan.column)
        ? plan.column
        : resolveColumnFlexible(prompt, report.columnNames);

    switch (plan.action) {
      case "summary":
        return { type: "summary", rationale: plan.rationale ?? "Ollama: summary", confidence: 0.85, source: "ollama" };
      case "distribution":
        return { type: "distribution", column: col, rationale: plan.rationale ?? "Ollama: distribution", confidence: 0.85, source: "ollama" };
      case "anomalies":
        return { type: "anomalies", column: col, rationale: plan.rationale ?? "Ollama: anomalies", confidence: 0.85, source: "ollama" };
      case "meaning":
        return { type: "meaning", column: col, rationale: plan.rationale ?? "Ollama: meaning", confidence: 0.85, source: "ollama" };
      case "quality":
        return { type: "quality", rationale: plan.rationale ?? "Ollama: quality", confidence: 0.85, source: "ollama" };
      case "reset":
        return { type: "reset", rationale: plan.rationale ?? "Ollama: reset", confidence: 0.9, source: "ollama" };
      case "help":
        return { type: "help", rationale: plan.rationale ?? "Ollama: help", confidence: 0.9, source: "ollama" };
      case "filter":
        return {
          type: "filter",
          prompt: plan.filter_prompt || prompt,
          rationale: plan.rationale ?? "Ollama: filter",
          confidence: 0.8,
          source: "ollama",
        };
      default:
        return { type: "unknown", prompt, rationale: plan.rationale ?? "Ollama uncertain", confidence: 0.4, source: "ollama" };
    }
  } catch {
    return null;
  }
}

export async function reason(
  prompt: string,
  report: InspectReport | null,
  opts?: { preferOllama?: boolean; ollamaBase?: string; ollamaModel?: string },
): Promise<ReasonedIntent> {
  const scored = reasonIntent(prompt, report);
  if (!opts?.preferOllama || !report) return scored;
  const llm = await reasonWithOllama(prompt, report, {
    baseUrl: opts.ollamaBase,
    model: opts.ollamaModel,
  });
  if (llm && llm.confidence >= scored.confidence) return llm;
  return scored;
}
