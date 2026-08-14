import { detectAnomalies } from "./anomalies";
import { describePlan, applyFilter } from "./filter-engine";
import { fitDistributions } from "./distributions";
import { inspectRows } from "./inspect";
import { looksAnalytical, narrateOpen } from "./narrate";
import { parseNaturalLanguage } from "./nl-parse";
import { reason, reasonIntent, resolveColumnFlexible, type ReasonedIntent } from "./reason";
import type {
  ChatMessage,
  ClarifyQuestion,
  DataRow,
  FilterGroup,
  FilterResult,
  InspectReport,
} from "./types";

export type AgentTurn = {
  messages: ChatMessage[];
  rows: DataRow[];
  result: FilterResult | null;
  inspect: InspectReport;
  pendingClarify?: ClarifyQuestion & { resumePlan?: FilterGroup };
};

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function say(role: ChatMessage["role"], text: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id: uid(), role, text, at: Date.now(), ...extra };
}

export function greetOnInspect(fileName: string, inspect: InspectReport): ChatMessage[] {
  const first = inspect.filterStrategy.applyFirst.join(", ");
  const quality = inspect.dataQuality.length
    ? ` I also noticed ${inspect.dataQuality.length} data-quality flag${inspect.dataQuality.length === 1 ? "" : "s"}.`
    : "";
  return [
    say(
      "agent",
      `Inspected **${fileName}** — ${inspect.nRows.toLocaleString()} rows × ${inspect.nCols} columns. ` +
        `Headers: ${inspect.columnNames.map((c) => "`" + c + "`").join(", ")}. ` +
        `I'll cut high-selectivity fields first (${first}) so AND combinations don't hide the rest of the table.${quality} ` +
        `Describe the slice you want, or ask what a column means. After filtering you can summarize, check anomalies, or fit a distribution on the current result.`,
    ),
  ];
}

function fmt(n: number) {
  return n.toLocaleString();
}

function withNote(text: string, intent: ReasonedIntent): string {
  if (!intent.rationale) return text;
  const tag = intent.source === "ollama" ? "local LLM" : "reasoner";
  return `_(\`${tag}\`: ${intent.rationale})_\n\n${text}`;
}

const WHY_RE =
  /\b(why|how come|what (?:drives|explains|causes)|reason for|looks? (?:like|this)|shape of)\b/i;

function keep(result: FilterResult | null): FilterResult | null {
  return result;
}

function narrateTurn(
  prompt: string,
  source: DataRow[],
  inspect: InspectReport,
  current: DataRow[],
  currentResult: FilterResult | null,
  note?: ReasonedIntent,
): AgentTurn {
  const text = narrateOpen(prompt, current, inspect, source.length);
  return {
    inspect,
    rows: current,
    result: keep(currentResult),
    messages: [say("agent", note ? withNote(text, note) : text)],
  };
}

/** Hard analytical cues — never route these to the filter parser. */
function analyticalOverride(prompt: string, report: InspectReport): ReasonedIntent | null {
  const lower = prompt.toLowerCase();
  const col = resolveColumnFlexible(prompt, report.columnNames);

  if (/\b(distribut\w*|histogram\w*|density|skew(?:ness)?|fit (?:a )?distribution)\b/i.test(lower)) {
    return {
      type: "distribution",
      column: col,
      rationale: "Hard guard: distribution language detected.",
      confidence: 0.95,
      source: "scored",
    };
  }
  if (/\b(summar\w*|overview|insights?|how many rows|tell me about (?:the )?(?:data|results?|slice))\b/i.test(lower)) {
    return {
      type: "summary",
      rationale: "Hard guard: summary language detected.",
      confidence: 0.95,
      source: "scored",
    };
  }
  if (/\b(anomal\w*|outlier\w*|unusual values?|strange values?)\b/i.test(lower)) {
    return {
      type: "anomalies",
      column: col,
      rationale: "Hard guard: anomaly language detected.",
      confidence: 0.95,
      source: "scored",
    };
  }
  if (/\b(what does .+ mean|meaning of|explain (?:the )?\w+|describe (?:the )?\w+ column)\b/i.test(lower)) {
    return {
      type: "meaning",
      column: col,
      rationale: "Hard guard: column-meaning language detected.",
      confidence: 0.9,
      source: "scored",
    };
  }
  if (/\b(data quality|missing(?:ness)?|duplicates?)\b/i.test(lower)) {
    return {
      type: "quality",
      rationale: "Hard guard: quality language detected.",
      confidence: 0.9,
      source: "scored",
    };
  }
  return null;
}

function runIntent(
  intent: ReasonedIntent,
  prompt: string,
  source: DataRow[],
  inspect: InspectReport,
  current: DataRow[],
  currentResult: FilterResult | null,
): AgentTurn {
  if (intent.type === "help") {
    return {
      inspect,
      rows: current,
      result: keep(currentResult),
      messages: [
        say(
          "agent",
          withNote(
            "Upload an Excel file (or load the sample), then tell me the rows you need. " +
              "After a filter is applied, ask to **summarize**, fit a **distribution**, check **anomalies**, or **explain a column** — those run on the current result.",
            intent,
          ),
        ),
      ],
    };
  }

  if (intent.type === "reset") {
    return {
      inspect,
      rows: source,
      result: null,
      messages: [say("agent", withNote(`Showing all ${fmt(source.length)} source rows again.`, intent))],
    };
  }

  if (intent.type === "meaning") {
    const cols = intent.column
      ? inspect.columns.filter((c) => c.name === intent.column)
      : inspect.columns;
    if (intent.column && !cols.length) {
      return {
        inspect,
        rows: current,
        result: keep(currentResult),
        messages: [
          say(
            "agent",
            withNote(
              `I don't have a column called \`${intent.column}\`. Headers: ${inspect.columnNames.map((c) => "`" + c + "`").join(", ")}.`,
              intent,
            ),
          ),
        ],
      };
    }
    const lines = cols.slice(0, 12).map((c) => `**${c.name}** (${c.kind}) — ${c.meaning}`);
    return {
      inspect,
      rows: current,
      result: keep(currentResult),
      messages: [say("agent", withNote(lines.join("\n\n"), intent))],
    };
  }

  if (intent.type === "quality") {
    const q = inspect.dataQuality;
    const text = q.length
      ? q.map((i) => `**${i.column}** · ${i.issue} — ${i.detail}`).join("\n\n")
      : "No structural quality issues (missingness, constants, identifiers) on this sheet.";
    return {
      inspect,
      rows: current,
      result: keep(currentResult),
      messages: [say("agent", withNote(text, intent))],
    };
  }

  if (intent.type === "summary") {
    const n = current.length;
    const working = n === source.length ? inspect : inspectRows(current);
    const bits = [
      n === source.length
        ? `Working set: all **${fmt(n)}** source rows.`
        : `Working set: **${fmt(n)}** of ${fmt(source.length)} source rows (current filter applied).`,
    ];
    for (const cat of working.columns.filter((c) => c.kind === "categorical" && c.valueCounts).slice(0, 3)) {
      const top = Object.entries(cat.valueCounts!)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k} (${v})`)
        .join(", ");
      bits.push("`" + cat.name + "` mix: " + top + ".");
    }
    for (const num of working.columns.filter((c) => c.kind.startsWith("numeric") && c.stats).slice(0, 3)) {
      const s = num.stats!;
      bits.push(
        "`" +
          num.name +
          "` median " +
          Number(s.median).toLocaleString(undefined, { maximumFractionDigits: 1 }) +
          ", mean " +
          Number(s.mean).toLocaleString(undefined, { maximumFractionDigits: 1 }) +
          ".",
      );
    }
    bits.push("Ask for anomalies or a distribution if you want the formulas.");
    return {
      inspect,
      rows: current,
      result: keep(currentResult),
      messages: [say("agent", withNote(bits.join(" "), intent))],
    };
  }

  if (intent.type === "anomalies") {
    const report = detectAnomalies(current, intent.column ? [intent.column] : undefined);
    const notable = report.columns.filter((c) => c.nFlagged > 0);
    const lines = [
      `Anomaly scan on the **current ${fmt(current.length)} rows**` +
        (intent.column ? ` (\`${intent.column}\`)` : "") +
        `. Chooser: ${report.methodSelection}`,
      "",
    ];
    if (!notable.length) {
      lines.push("No flags under the default fences.");
    } else {
      for (const c of notable.slice(0, 4)) {
        lines.push(`**${c.column}** — ${c.formula.name}`);
        lines.push("Formula: `" + c.formula.formula + "`");
        lines.push(`Why this method: ${c.why}`);
        lines.push(
          `${c.nFlagged} flagged. Example: ${c.records.slice(0, 3).map((r) => String(r.value)).join(", ")}.`,
        );
        lines.push("");
      }
    }
    return {
      inspect,
      rows: current,
      result: keep(currentResult),
      messages: [say("agent", withNote(lines.join("\n"), intent))],
    };
  }

  if (intent.type === "distribution") {
    // "why is the distribution like this?" should explain, not just name a family.
    if (WHY_RE.test(prompt)) {
      return narrateTurn(prompt, source, inspect, current, currentResult, intent);
    }
    const fits = fitDistributions(current, intent.column ? [intent.column] : undefined);
    if (!fits.length) {
      const nums = inspect.columns
        .filter((c) => c.kind.startsWith("numeric"))
        .map((c) => "`" + c.name + "`");
      return {
        inspect,
        rows: current,
        result: keep(currentResult),
        messages: [
          say(
            "agent",
            withNote(
              intent.column
                ? `I couldn't fit a distribution for \`${intent.column}\`. Numeric columns: ${nums.join(", ") || "none"}.`
                : `No numeric columns to fit on the current ${fmt(current.length)} rows.`,
              intent,
            ),
          ),
        ],
      };
    }
    const scope = intent.column
      ? `for \`${intent.column}\``
      : `on the current ${fmt(current.length)} rows`;
    const lines = [
      `Distribution fit ${scope}:`,
      "",
      ...fits.slice(0, 5).map((f) => {
        return (
          `**${f.column}** → ${f.family.name}\n` +
          `Rule: ${f.why}\n` +
          "Density: `" +
          f.family.pdf +
          "`\n" +
          `Fitted: ${Object.entries(f.fitted)
            .map(([k, v]) => `${k}=${v == null ? "—" : Number(v).toPrecision(4)}`)
            .join(", ")}`
        );
      }),
    ];
    return {
      inspect,
      rows: current,
      result: keep(currentResult),
      messages: [say("agent", withNote(lines.join("\n"), intent))],
    };
  }

  if (intent.type === "unknown") {
    if (looksAnalytical(prompt)) {
      return narrateTurn(prompt, source, inspect, current, currentResult, intent);
    }
    return {
      inspect,
      rows: current,
      result: keep(currentResult),
      messages: [
        say(
          "agent",
          withNote(
            `I can **filter** rows, **summarize** the current ${fmt(current.length)} results, check **anomalies**, fit a **distribution**, or **explain a column**. ` +
              `Examples: "Age between 25 and 40 and Department is Sales", "summarize the filtered results", "distribution of Salary", "are there anomalies?".`,
            intent,
          ),
        ),
      ],
    };
  }

  // filter path — with last-chance analytical re-route if parser fails
  const filterPrompt = intent.type === "filter" ? intent.prompt : prompt;
  const parsed = parseNaturalLanguage(filterPrompt, inspect);
  if (!parsed.ok) {
    if (looksAnalytical(prompt) || WHY_RE.test(prompt)) {
      return narrateTurn(prompt, source, inspect, current, currentResult, intent);
    }
    const retry = analyticalOverride(prompt, inspect) ?? reasonIntent(prompt, inspect);
    if (retry.type !== "filter" && retry.type !== "unknown") {
      return runIntent(retry, prompt, source, inspect, current, currentResult);
    }
    return {
      inspect,
      rows: current,
      result: keep(currentResult),
      pendingClarify: parsed.partial
        ? { ...parsed.clarify, resumePlan: parsed.partial }
        : parsed.clarify,
      messages: [
        say(
          "agent",
          withNote(
            parsed.clarify.question.includes("couldn't")
              ? `I couldn't turn that into a filter. ` +
                  `If you meant analysis on the current ${fmt(current.length)} rows, try "summarize the filtered results", "distribution of Salary", or "are there anomalies?". ` +
                  `For a filter, name a column and a condition — e.g. "Age between 25 and 40 and Department is Sales".`
              : parsed.clarify.question,
            intent,
          ),
        ),
      ],
    };
  }

  const result = applyFilter(source, parsed.plan);
  const insights: string[] = [];
  if (result.empty) {
    insights.push("Nothing matched. Try loosening a range or using OR for labels.");
  } else {
    insights.push("Download the CSV, or ask to summarize, flag anomalies, or fit a distribution.");
  }

  const text =
    `Applied **${describePlan(result.plan)}**.\n\n${result.summary}\n\n` +
    `AND predicates ran in selectivity order (categorical / date first) so earlier cuts stay visible in the trace.`;

  return {
    inspect,
    rows: result.rows,
    result,
    messages: [say("agent", withNote(text, intent), { plan: result.plan, insights })],
  };
}

function decideAndRun(
  prompt: string,
  source: DataRow[],
  inspect: InspectReport,
  current: DataRow[],
  currentResult: FilterResult | null,
  intent: ReasonedIntent,
): AgentTurn {
  if (WHY_RE.test(prompt)) {
    return narrateTurn(prompt, source, inspect, current, currentResult, intent);
  }
  return runIntent(intent, prompt, source, inspect, current, currentResult);
}

export function handlePrompt(
  prompt: string,
  source: DataRow[],
  inspect: InspectReport,
  current: DataRow[],
  currentResult: FilterResult | null = null,
): AgentTurn {
  if (WHY_RE.test(prompt)) {
    return narrateTurn(prompt, source, inspect, current, currentResult);
  }

  const hard = analyticalOverride(prompt, inspect);
  if (hard) return runIntent(hard, prompt, source, inspect, current, currentResult);

  if (looksAnalytical(prompt)) {
    const scored = reasonIntent(prompt, inspect);
    if (scored.type !== "filter" && scored.type !== "unknown") {
      return runIntent(scored, prompt, source, inspect, current, currentResult);
    }
    return narrateTurn(prompt, source, inspect, current, currentResult, scored);
  }

  const intent = reasonIntent(prompt, inspect);
  return decideAndRun(prompt, source, inspect, current, currentResult, intent);
}

export async function handlePromptAsync(
  prompt: string,
  source: DataRow[],
  inspect: InspectReport,
  current: DataRow[],
  opts?: {
    preferOllama?: boolean;
    ollamaBase?: string;
    ollamaModel?: string;
    currentResult?: FilterResult | null;
  },
): Promise<AgentTurn> {
  const currentResult = opts?.currentResult ?? null;
  const prefer =
    opts?.preferOllama === true ||
    (typeof localStorage !== "undefined" && localStorage.getItem("ledgerPreferOllama") === "1");

  if (!prefer) {
    return handlePrompt(prompt, source, inspect, current, currentResult);
  }

  if (WHY_RE.test(prompt)) {
    return narrateTurn(prompt, source, inspect, current, currentResult);
  }

  const hard = analyticalOverride(prompt, inspect);
  if (hard) return runIntent(hard, prompt, source, inspect, current, currentResult);

  if (looksAnalytical(prompt)) {
    const scored = reasonIntent(prompt, inspect);
    if (scored.type !== "filter" && scored.type !== "unknown") {
      return runIntent(scored, prompt, source, inspect, current, currentResult);
    }
    return narrateTurn(prompt, source, inspect, current, currentResult, scored);
  }

  const intent = await reason(prompt, inspect, {
    preferOllama: true,
    ollamaBase: opts?.ollamaBase,
    ollamaModel: opts?.ollamaModel,
  });
  return decideAndRun(prompt, source, inspect, current, currentResult, intent);
}

export function acceptClarify(plan: FilterGroup, source: DataRow[], inspect: InspectReport): AgentTurn {
  const result = applyFilter(source, plan);
  return {
    inspect,
    rows: result.rows,
    result,
    messages: [
      say("agent", `Using OR / in for the same-column values. ${result.summary}`, {
        plan: result.plan,
      }),
    ],
  };
}
