import { detectAnomalies } from "./anomalies";
import { describePlan, applyFilter } from "./filter-engine";
import { fitDistributions } from "./distributions";
import { inspectRows } from "./inspect";
import { classifyIntent, parseNaturalLanguage } from "./nl-parse";
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
        `Headers: ${inspect.columnNames.map((c) => `\`${c}\``).join(", ")}. ` +
        `I'll cut high-selectivity fields first (${first}) so AND combinations don't hide the rest of the table.${quality} ` +
        `Describe the slice you want, or ask what a column means.`,
    ),
  ];
}

function fmt(n: number) {
  return n.toLocaleString();
}

export function handlePrompt(
  prompt: string,
  source: DataRow[],
  inspect: InspectReport,
  current: DataRow[],
): AgentTurn {
  const intent = classifyIntent(prompt, inspect);

  if (intent.type === "help") {
    return {
      inspect,
      rows: current,
      result: null,
      messages: [
        say(
          "agent",
          "Upload an Excel file (or load the sample), then tell me the rows you need. " +
            "I inspect real headers first and never invent columns. Try “Age between 25 and 40 and Department is Sales”, " +
            "“only 2024 where Status is Active”, “are there anomalies?”, or “what distribution is Salary?”. " +
            "If anything is ambiguous I'll ask before filtering.",
        ),
      ],
    };
  }

  if (intent.type === "reset") {
    return {
      inspect,
      rows: source,
      result: null,
      messages: [say("agent", `Showing all ${fmt(source.length)} source rows again.`)],
    };
  }

  if (intent.type === "meaning") {
    const cols = intent.column
      ? inspect.columns.filter((c) => c.name === intent.column)
      : inspect.columns;
    const lines = cols.map((c) => `**${c.name}** (${c.kind}) — ${c.meaning}`);
    return {
      inspect,
      rows: current,
      result: null,
      messages: [say("agent", lines.join("\n\n"))],
    };
  }

  if (intent.type === "quality") {
    const q = inspect.dataQuality;
    const text = q.length
      ? q.map((i) => `**${i.column}** · ${i.issue} — ${i.detail}`).join("\n\n")
      : "No structural quality issues (missingness, constants, identifiers) on this sheet.";
    return { inspect, rows: current, result: null, messages: [say("agent", text)] };
  }

  if (intent.type === "summary") {
    const n = current.length;
    const cat = inspect.columns.find((c) => c.kind === "categorical");
    const num = inspect.columns.find((c) => c.kind === "numeric_continuous" && c.stats);
    const bits = [
      `Working set: **${fmt(n)}** of ${fmt(source.length)} source rows.`,
    ];
    if (cat?.valueCounts) {
      const top = Object.entries(cat.valueCounts)
        .slice(0, 4)
        .map(([k, v]) => `${k} (${v})`)
        .join(", ");
      bits.push(`\`${cat.name}\` mix: ${top}.`);
    }
    if (num?.stats) {
      bits.push(
        `\`${num.name}\` median ${Number(num.stats.median).toLocaleString(undefined, { maximumFractionDigits: 1 })}, ` +
          `IQR ${Number(num.stats.q1).toFixed(0)}–${Number(num.stats.q3).toFixed(0)}.`,
      );
    }
    bits.push("Ask for anomalies or a distribution if you want the formulas.");
    return { inspect, rows: current, result: null, messages: [say("agent", bits.join(" "))] };
  }

  if (intent.type === "anomalies") {
    const workingInspect = inspectRows(current);
    const report = detectAnomalies(current, intent.column ? [intent.column] : undefined);
    const notable = report.columns.filter((c) => c.nFlagged > 0);
    const lines = [
      `Anomaly scan on the **current ${fmt(current.length)} rows**. Chooser: ${report.methodSelection}`,
      "",
    ];
    if (!notable.length) {
      lines.push("No flags under the default fences.");
    } else {
      for (const c of notable.slice(0, 4)) {
        lines.push(`**${c.column}** — ${c.formula.name}`);
        lines.push(`Formula: \`${c.formula.formula}\``);
        lines.push(`Why this method: ${c.why}`);
        lines.push(`${c.nFlagged} flagged. Example: ${c.records.slice(0, 3).map((r) => String(r.value)).join(", ")}.`);
        lines.push("");
      }
    }
    void workingInspect;
    return { inspect, rows: current, result: null, messages: [say("agent", lines.join("\n"))] };
  }

  if (intent.type === "distribution") {
    const fits = fitDistributions(current, intent.column ? [intent.column] : undefined);
    if (!fits.length) {
      return {
        inspect,
        rows: current,
        result: null,
        messages: [say("agent", "No numeric columns to fit. Ask about a specific measure.")],
      };
    }
    const lines = fits.slice(0, 5).map((f) => {
      return (
        `**${f.column}** → ${f.family.name}\n` +
        `Rule: ${f.why}\n` +
        `Density: \`${f.family.pdf}\`\n` +
        `Fitted: ${Object.entries(f.fitted)
          .map(([k, v]) => `${k}=${v == null ? "—" : Number(v).toPrecision(4)}`)
          .join(", ")}`
      );
    });
    return { inspect, rows: current, result: null, messages: [say("agent", lines.join("\n\n"))] };
  }

  // filter or unknown-as-filter
  const parsed = parseNaturalLanguage(prompt, inspect);
  if (!parsed.ok) {
    return {
      inspect,
      rows: current,
      result: null,
      pendingClarify: parsed.partial
        ? { ...parsed.clarify, resumePlan: parsed.partial }
        : parsed.clarify,
      messages: [say("agent", parsed.clarify.question)],
    };
  }

  const result = applyFilter(source, parsed.plan);
  const insights: string[] = [];
  if (result.empty) {
    const killer = result.trace.find((t) => t.emptiedResult);
    insights.push(
      killer && killer.predicate && "column" in killer.predicate
        ? `\`${killer.predicate.column}\` ${killer.predicate.op} hid every remaining row. Relax that predicate or switch same-column values to OR.`
        : "Nothing matched. Try loosening a range or using OR for labels.",
    );
  } else {
    const cat = inspect.columns.find((c) => c.kind === "categorical");
    if (cat) {
      const counts = new Map<string, number>();
      for (const r of result.rows) {
        const k = String(r[cat.name] ?? "");
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top) insights.push(`Dominant \`${cat.name}\` in the slice: ${top[0]} (${top[1]}).`);
    }
    insights.push("Download the CSV, or ask to summarize, flag anomalies, or fit a distribution.");
  }

  const text =
    `Applied **${describePlan(result.plan)}**.\n\n${result.summary}\n\n` +
    `AND predicates ran in selectivity order (categorical / date first) so earlier cuts stay visible in the trace.`;

  return {
    inspect,
    rows: result.rows,
    result,
    messages: [say("agent", text, { plan: result.plan, insights })],
  };
}

export function acceptClarify(plan: FilterGroup, source: DataRow[], inspect: InspectReport): AgentTurn {
  return applyDirect(plan, source, inspect);
}

function applyDirect(plan: FilterGroup, source: DataRow[], inspect: InspectReport): AgentTurn {
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
