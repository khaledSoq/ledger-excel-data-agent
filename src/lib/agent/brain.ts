import { detectAnomalies } from "./anomalies";
import { describePlan, applyFilter } from "./filter-engine";
import { fitDistributions } from "./distributions";
import { inspectRows } from "./inspect";
import { parseNaturalLanguage } from "./nl-parse";
import { reason, reasonIntent } from "./reason";
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
        `Describe the slice you want, or ask what a column means. After filtering you can summarize, check anomalies, or fit a distribution.`,
    ),
  ];
}

function fmt(n: number) {
  return n.toLocaleString();
}

function runIntent(
  intent: { type: string; column?: string; prompt?: string; rationale?: string; source?: string },
  prompt: string,
  source: DataRow[],
  inspect: InspectReport,
  current: DataRow[],
): AgentTurn {
  const note = intent.rationale
    ? "_(" + (intent.source === "ollama" ? "local LLM" : "reasoner") + ": " + intent.rationale + ")_\n\n"
    : "";

  if (intent.type === "help") {
    return {
      inspect, rows: current, result: null,
      messages: [say("agent", note + "Upload an Excel file (or load the sample), then tell me the rows you need. After a filter, ask to summarize, fit a distribution, check anomalies, or explain a column.")],
    };
  }
  if (intent.type === "reset") {
    return {
      inspect, rows: source, result: null,
      messages: [say("agent", note + `Showing all ${fmt(source.length)} source rows again.`)],
    };
  }
  if (intent.type === "meaning") {
    const cols = intent.column ? inspect.columns.filter((c) => c.name === intent.column) : inspect.columns;
    const lines = cols.slice(0, 12).map((c) => `**${c.name}** (${c.kind}) — ${c.meaning}`);
    return { inspect, rows: current, result: null, messages: [say("agent", note + lines.join("\n\n"))] };
  }
  if (intent.type === "quality") {
    const q = inspect.dataQuality;
    const text = q.length ? q.map((i) => `**${i.column}** · ${i.issue} — ${i.detail}`).join("\n\n") : "No structural quality issues on this sheet.";
    return { inspect, rows: current, result: null, messages: [say("agent", note + text)] };
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
      const top = Object.entries(cat.valueCounts!).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + " (" + v + ")").join(", ");
      bits.push("`" + cat.name + "` mix: " + top + ".");
    }
    for (const num of working.columns.filter((c) => c.kind.startsWith("numeric") && c.stats).slice(0, 3)) {
      const s = num.stats!;
      bits.push("`" + num.name + "` median " + Number(s.median).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ", mean " + Number(s.mean).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ".");
    }
    bits.push("Ask for anomalies or a distribution if you want the formulas.");
    return { inspect, rows: current, result: null, messages: [say("agent", note + bits.join(" "))] };
  }
  if (intent.type === "anomalies") {
    const report = detectAnomalies(current, intent.column ? [intent.column] : undefined);
    const notable = report.columns.filter((c) => c.nFlagged > 0);
    const lines = [`Anomaly scan on the **current ${fmt(current.length)} rows**` + (intent.column ? " (`" + intent.column + "`)" : "") + `. Chooser: ${report.methodSelection}`, ""];
    if (!notable.length) lines.push("No flags under the default fences.");
    else {
      for (const c of notable.slice(0, 4)) {
        lines.push(`**${c.column}** — ${c.formula.name}`);
        lines.push("Formula: `" + c.formula.formula + "`");
        lines.push(`Why this method: ${c.why}`);
        lines.push(String(c.nFlagged) + " flagged. Example: " + c.records.slice(0, 3).map((r) => String(r.value)).join(", ") + ".");
        lines.push("");
      }
    }
    return { inspect, rows: current, result: null, messages: [say("agent", note + lines.join("\n"))] };
  }
  if (intent.type === "distribution") {
    const fits = fitDistributions(current, intent.column ? [intent.column] : undefined);
    if (!fits.length) {
      return { inspect, rows: current, result: null, messages: [say("agent", note + "No numeric columns to fit. Ask about a specific measure.")] };
    }
    const scope = intent.column ? "for `" + intent.column + "`" : "on the current " + fmt(current.length) + " rows";
    const lines = ["Distribution fit " + scope + ":", ""];
    for (const f of fits.slice(0, 5)) {
      lines.push(`**${f.column}** → ${f.family.name}`);
      lines.push(`Rule: ${f.why}`);
      lines.push("Density: `" + f.family.pdf + "`");
      lines.push("Fitted: " + Object.entries(f.fitted).map(([k, v]) => k + "=" + (v == null ? "—" : Number(v).toPrecision(4))).join(", "));
      lines.push("");
    }
    return { inspect, rows: current, result: null, messages: [say("agent", note + lines.join("\n"))] };
  }
  if (intent.type === "unknown") {
    return {
      inspect, rows: current, result: null,
      messages: [say("agent", note + "I can filter rows, summarize the current " + fmt(current.length) + " results, check anomalies, fit a distribution, or explain a column.")],
    };
  }
  const filterPrompt = intent.type === "filter" && intent.prompt ? intent.prompt : prompt;
  const parsed = parseNaturalLanguage(filterPrompt, inspect);
  if (!parsed.ok) {
    return {
      inspect, rows: current, result: null,
      pendingClarify: parsed.partial ? { ...parsed.clarify, resumePlan: parsed.partial } : parsed.clarify,
      messages: [say("agent", note + parsed.clarify.question)],
    };
  }
  const result = applyFilter(source, parsed.plan);
  const insights: string[] = [];
  if (result.empty) {
    insights.push("Nothing matched. Try loosening a range or using OR for labels.");
  } else {
    insights.push("Download the CSV, or ask to summarize, flag anomalies, or fit a distribution.");
  }
  const text = `Applied **${describePlan(result.plan)}**.\n\n${result.summary}\n\nAND predicates ran in selectivity order.`;
  return {
    inspect, rows: result.rows, result,
    messages: [say("agent", note + text, { plan: result.plan, insights })],
  };
}

export function handlePrompt(
  prompt: string,
  source: DataRow[],
  inspect: InspectReport,
  current: DataRow[],
): AgentTurn {
  return runIntent(reasonIntent(prompt, inspect), prompt, source, inspect, current);
}

export async function handlePromptAsync(
  prompt: string,
  source: DataRow[],
  inspect: InspectReport,
  current: DataRow[],
  opts?: { preferOllama?: boolean; ollamaBase?: string; ollamaModel?: string },
): Promise<AgentTurn> {
  const prefer =
    opts?.preferOllama ??
    (typeof localStorage !== "undefined" && localStorage.getItem("ledgerPreferOllama") === "1");
  const intent = await reason(prompt, inspect, {
    preferOllama: prefer !== false,
    ollamaBase: opts?.ollamaBase,
    ollamaModel: opts?.ollamaModel,
  });
  return runIntent(intent, prompt, source, inspect, current);
}

export function acceptClarify(plan: FilterGroup, source: DataRow[], inspect: InspectReport): AgentTurn {
  const result = applyFilter(source, plan);
  return {
    inspect,
    rows: result.rows,
    result,
    messages: [say("agent", `Using OR / in for the same-column values. ${result.summary}`, { plan: result.plan })],
  };
}
