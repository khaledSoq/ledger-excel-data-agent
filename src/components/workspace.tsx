import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  BookOpen,
  Download,
  FileSpreadsheet,
  Filter,
  RotateCcw,
  Sigma,
} from "lucide-react";
import { AuthSlot } from "@/components/auth-slot";
import { MarkdownLite } from "@/components/markdown-lite";
import { useAgent } from "@/lib/agent/store";
import { describePlan } from "@/lib/agent/filter-engine";
import { detectAnomalies } from "@/lib/agent/anomalies";
import { fitDistributions } from "@/lib/agent/distributions";
import type { ColumnMeta, DataRow } from "@/lib/agent/types";

const PROMPTS = [
  "All Inactive or On Leave employees from Finance or HR",
  "Active or On Leave people in Sales or Marketing",
  "Employees who are Inactive from Engineering",
  "Age between 25 and 40 and Department is Sales",
  "Only records from 2024 where Status is Active",
  "Are there any anomalies? Which formula did you use?",
];

export function Workspace() {
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [tab, setTab] = useState<"table" | "inspect" | "formulas">("table");

  const {
    fileName,
    source,
    rows,
    inspect,
    result,
    messages,
    pending,
    busy,
    error,
    loadSample,
    loadFile,
    send,
    chooseOption,
    download,
  } = useAgent();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  const anomaly = useMemo(() => (rows.length ? detectAnomalies(rows) : null), [rows]);
  const dists = useMemo(() => (rows.length ? fitDistributions(rows) : []), [rows]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    send(text);
    setDraft("");
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="font-mono text-[11px] tracking-[0.2em] text-subtle uppercase">Local data agent</p>
          <h1 className="font-display text-xl font-medium tracking-tight sm:text-2xl">Ledger</h1>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.xlsm,.csv"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void loadFile(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-11 items-center rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium"
          >
            Upload
          </button>
          <button
            type="button"
            onClick={loadSample}
            className="inline-flex h-11 items-center rounded-lg border border-line px-3 text-sm text-muted hover:text-ink"
          >
            Sample
          </button>
          <AuthSlot />
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1440px] flex-1 grid-cols-1 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <section className="flex min-h-[46dvh] flex-col border-b border-line md:min-h-0 md:border-r md:border-b-0">
          <div className="flex items-start justify-between gap-3 px-4 pt-5 sm:px-5">
            <div>
              <h2 className="font-display text-lg font-medium">Conversation</h2>
              <p className="mt-1 text-sm text-muted">Plan → inspect → filter → explain.</p>
            </div>
            <span className="mt-1 shrink-0 rounded-full border border-line px-2.5 py-1 font-mono text-[10px] tracking-wide text-subtle uppercase">
              Local tools
            </span>
          </div>

          <div className="mt-4 flex-1 space-y-4 overflow-y-auto px-4 pb-3 sm:px-5">
            {messages.map((m) => (
              <article
                key={m.id}
                className={
                  m.role === "user"
                    ? "ml-8 rounded-xl rounded-br-sm bg-surface-2 px-3.5 py-2.5 text-[15px] leading-relaxed"
                    : "mr-4"
                }
              >
                {m.role === "user" ? (
                  m.text
                ) : (
                  <>
                    <p className="mb-1.5 font-mono text-[10px] tracking-[0.16em] text-subtle uppercase">
                      Agent
                    </p>
                    <MarkdownLite text={m.text} />
                    {m.insights?.length ? (
                      <ul className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm text-muted">
                        {m.insights.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                )}
              </article>
            ))}
            {pending?.options?.length ? (
              <div className="flex flex-wrap gap-2">
                {pending.options.map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => chooseOption(opt)}
                    className="rounded-full border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink transition-colors duration-150 hover:bg-paper hover:text-paper-ink"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          <form onSubmit={onSubmit} className="border-t border-line p-3 sm:p-4">
            <div className="flex flex-wrap gap-1.5 pb-2">
              {PROMPTS.slice(0, 3).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => send(p)}
                  className="rounded-full border border-line px-2.5 py-1 text-left text-xs text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink"
                >
                  {p}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-1.5 focus-within:border-line-strong">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSubmit(e);
                  }
                }}
                rows={2}
                placeholder={
                  inspect
                    ? "Describe the rows you need…"
                    : "Upload a file first, then describe the data you need"
                }
                className="min-h-12 flex-1 resize-none bg-transparent px-2.5 py-2 text-[15px] text-ink outline-none placeholder:text-subtle"
              />
              <button
                type="submit"
                aria-label="Send"
                className="mb-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-paper text-paper-ink transition-transform duration-150 hover:opacity-90 active:scale-[0.98]"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </form>
        </section>

        <section className="flex min-w-0 flex-col">
          <div className="flex flex-col gap-3 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-muted" />
                <p className="truncate text-sm font-medium">{fileName ?? "No workbook"}</p>
                {result ? (
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-sage">
                    {result.nMatched.toLocaleString()} / {result.nInput.toLocaleString()}
                  </span>
                ) : source.length ? (
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-muted">
                    {source.length.toLocaleString()} rows
                  </span>
                ) : null}
              </div>
              {result ? (
                <p className="mt-1 truncate font-mono text-[11px] text-subtle">{describePlan(result.plan)}</p>
              ) : (
                <p className="mt-1 text-sm text-muted">
                  {inspect
                    ? "Working on the full sheet until you filter."
                    : "Upload .xlsx / .xls / .csv, or load the sample."}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3.5 text-sm font-medium md:hidden"
              >
                Upload Excel
              </button>
              <button
                type="button"
                onClick={loadSample}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-line px-3.5 text-sm text-muted hover:text-ink sm:hidden"
              >
                Load sample
              </button>
              <button
                type="button"
                disabled={!rows.length}
                onClick={download}
                className="inline-flex h-11 items-center gap-2 rounded-lg bg-paper px-3.5 text-sm font-medium text-paper-ink disabled:opacity-40"
              >
                <Download className="h-4 w-4" />
                CSV
              </button>
            </div>
          </div>

          {error ? (
            <p className="mx-4 mt-3 rounded-lg border border-clay/40 bg-clay/10 px-3 py-2 text-sm text-clay sm:mx-6">
              {error}
            </p>
          ) : null}
          {busy ? <p className="px-6 pt-3 text-sm text-muted">Reading workbook…</p> : null}

          <div className="flex gap-1 px-4 pt-3 sm:px-6">
            {(
              [
                ["table", "Result", Filter],
                ["inspect", "Inspect", BookOpen],
                ["formulas", "Formulas", Sigma],
              ] as const
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={
                  tab === id
                    ? "inline-flex h-10 items-center gap-1.5 rounded-lg bg-surface-2 px-3 text-sm font-medium"
                    : "inline-flex h-10 items-center gap-1.5 rounded-lg px-3 text-sm text-muted hover:text-ink"
                }
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
            {result ? (
              <button
                type="button"
                onClick={() => send("show all")}
                className="ml-auto inline-flex h-10 items-center gap-1.5 px-2 text-sm text-muted hover:text-ink"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </button>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
            {tab === "table" ? <ResultTable rows={rows} /> : null}
            {tab === "inspect" && inspect ? <InspectPanel columns={inspect.columns} /> : null}
            {tab === "inspect" && !inspect ? <EmptyHint /> : null}
            {tab === "formulas" ? (
              <FormulasPanel
                anomalyCount={anomaly?.nRowsFlagged ?? 0}
                method={anomaly?.methodSelection ?? ""}
                dists={dists.map((d) => ({
                  column: d.column,
                  name: d.family.name,
                  pdf: d.family.pdf,
                  why: d.why,
                }))}
              />
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="rounded-2xl border border-dashed border-line px-5 py-10 text-center">
      <p className="font-display text-lg">No sheet yet</p>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted">
        Upload a workbook or load the sample. I will list every real column before any filter runs.
      </p>
    </div>
  );
}

function ResultTable({ rows }: { rows: DataRow[] }) {
  if (!rows.length) {
    return (
      <div className="rounded-2xl border border-line bg-surface px-5 py-10 text-center">
        <p className="font-display text-lg">No matching rows</p>
        <p className="mt-2 text-sm text-muted">Relax a predicate or switch same-column values to OR.</p>
      </div>
    );
  }
  const cols = Object.keys(rows[0] ?? {});
  const shown = rows.slice(0, 80);
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-surface-2 text-xs tracking-wide text-muted uppercase">
            <tr>
              {cols.map((c) => (
                <th key={c} className="whitespace-nowrap px-3 py-2.5 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i} className="border-t border-line">
                {cols.map((c) => (
                  <td key={c} className="whitespace-nowrap px-3 py-2 font-mono text-[13px] tabular-nums">
                    {row[c] == null ? "—" : String(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length ? (
        <p className="border-t border-line px-3 py-2 text-xs text-subtle">
          Showing {shown.length} of {rows.length.toLocaleString()} — download the CSV for the rest.
        </p>
      ) : null}
    </div>
  );
}

function InspectPanel({ columns }: { columns: ColumnMeta[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {columns.map((c) => (
        <article key={c.name} className="rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="font-medium">{c.name}</h3>
            <span className="font-mono text-[10px] tracking-wide text-subtle uppercase">{c.kind}</span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-muted">{c.meaning}</p>
          {c.stats && "mean" in c.stats ? (
            <p className="mt-3 font-mono text-[12px] tabular-nums text-subtle">
              μ {Number(c.stats.mean).toFixed(1)} · med {Number(c.stats.median).toFixed(1)} · IQR{" "}
              {Number(c.stats.q1).toFixed(0)}–{Number(c.stats.q3).toFixed(0)}
            </p>
          ) : null}
          {c.kind === "categorical" || c.kind === "boolean" ? (
            c.uniqueValues && c.uniqueValues.length <= 12 ? (
              <p className="mt-3 text-xs text-subtle">{c.uniqueValues.join(" · ")}</p>
            ) : null
          ) : null}
          <p className="mt-3 text-xs text-subtle">{c.selectivityHint}</p>
        </article>
      ))}
    </div>
  );
}

function FormulasPanel({
  anomalyCount,
  method,
  dists,
}: {
  anomalyCount: number;
  method: string;
  dists: Array<{ column: string; name: string; pdf: string; why: string }>;
}) {
  return (
    <div className="space-y-4">
      <article className="rounded-2xl border border-line bg-surface p-5">
        <h3 className="font-display text-lg">Anomaly chooser</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted">{method || "Load data to scan."}</p>
        <ul className="mt-4 space-y-2 font-mono text-[12px] leading-relaxed text-ink/85">
          <li>IQR = Q3 − Q1; fences Q1 − 1.5·IQR and Q3 + 1.5·IQR</li>
          <li>{"z = (x − μ) / σ , flag |z| > 3"}</li>
          <li>{"M = 0.6745 · (x − median) / MAD , flag |M| > 3.5"}</li>
          <li>{"Rare label: p̂ = nⱼ / n , flag p̂ < 0.01 or nⱼ = 1"}</li>
        </ul>
        <p className="mt-3 text-sm text-sage">{anomalyCount} row{anomalyCount === 1 ? "" : "s"} currently flagged.</p>
      </article>
      <article className="rounded-2xl border border-line bg-surface p-5">
        <h3 className="font-display text-lg">Distribution families</h3>
        <p className="mt-2 text-sm text-muted">
          {"Counts + var≈mean → Poisson · flat → Uniform · CV≈1 → Exponential · ln x closer to normal → Lognormal · other positive skew → Gamma · |skew| < 0.5 → Normal."}
        </p>
        <div className="mt-4 space-y-3">
          {dists.length ? (
            dists.map((d) => (
              <div key={d.column} className="border-t border-line pt-3">
                <p className="text-sm font-medium">
                  {d.column} → {d.name}
                </p>
                <p className="mt-1 font-mono text-[12px] text-subtle">{d.pdf}</p>
                <p className="mt-1 text-sm text-muted">{d.why}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted">Load a sheet to fit families.</p>
          )}
        </div>
      </article>
    </div>
  );
}
