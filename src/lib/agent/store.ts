import { create } from "zustand";
import { acceptClarify, greetOnInspect, handlePromptAsync, say } from "./brain";
import { downloadCsv, parseWorkbook } from "./excel";
import { inspectRows } from "./inspect";
import { buildSampleEmployees, SAMPLE_BLURB, SAMPLE_FILE_NAME } from "./sample-data";
import type { ChatMessage, ClarifyQuestion, DataRow, FilterGroup, FilterResult, InspectReport } from "./types";

type AgentState = {
  fileName: string | null;
  source: DataRow[];
  rows: DataRow[];
  inspect: InspectReport | null;
  result: FilterResult | null;
  messages: ChatMessage[];
  pending: (ClarifyQuestion & { resumePlan?: FilterGroup }) | null;
  busy: boolean;
  error: string | null;
  loadSample: () => void;
  loadFile: (file: File) => Promise<void>;
  send: (text: string) => void;
  chooseOption: (option: string) => void;
  resetFilter: () => void;
  download: () => void;
};

const welcome: ChatMessage[] = [
  say(
    "agent",
    "Please upload your Excel file, then describe the data you need. " +
      "I inspect real headers first and never invent column names. " +
      "You can filter rows, then ask free-form questions: summarize, distribution of salaries, anomalies, or why a measure looks skewed. " +
      "(Agent build 2026-08-14-analytics)",
  ),
];

export const useAgent = create<AgentState>((set, get) => ({
  fileName: null,
  source: [],
  rows: [],
  inspect: null,
  result: null,
  messages: welcome,
  pending: null,
  busy: false,
  error: null,

  loadSample: () => {
    const source = buildSampleEmployees();
    const inspect = inspectRows(source);
    set({
      fileName: SAMPLE_FILE_NAME,
      source,
      rows: source,
      inspect,
      result: null,
      pending: null,
      error: null,
      messages: [
        ...get().messages,
        say("user", "Load the sample workbook"),
        ...greetOnInspect(SAMPLE_FILE_NAME, inspect),
        say("agent", SAMPLE_BLURB),
      ],
    });
  },

  loadFile: async (file) => {
    set({ busy: true, error: null });
    try {
      const parsed = await parseWorkbook(file);
      const inspect = inspectRows(parsed.rows);
      set({
        fileName: parsed.name,
        source: parsed.rows,
        rows: parsed.rows,
        inspect,
        result: null,
        pending: null,
        busy: false,
        messages: [
          ...get().messages,
          say("user", `Uploaded ${parsed.name}`),
          ...greetOnInspect(parsed.name, inspect),
        ],
      });
    } catch (err) {
      set({
        busy: false,
        error: err instanceof Error ? err.message : "Could not read that file.",
      });
    }
  },

  send: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const { inspect, source, rows, result } = get();
    set((s) => ({
      messages: [...s.messages, say("user", trimmed)],
      pending: null,
      busy: true,
    }));
    if (!inspect || !source.length) {
      set((s) => ({
        busy: false,
        messages: [
          ...s.messages,
          say("agent", "Please upload your Excel file first — or load the sample workbook."),
        ],
      }));
      return;
    }
    void handlePromptAsync(trimmed, source, inspect, rows, {
      preferOllama: false,
      currentResult: result,
    })
      .then((turn) => {
        set((s) => ({
          busy: false,
          rows: turn.rows,
          result: turn.result,
          pending: turn.pendingClarify ?? null,
          messages: [...s.messages, ...turn.messages],
        }));
      })
      .catch(() => {
        set((s) => ({
          busy: false,
          messages: [
            ...s.messages,
            say("agent", "Something went wrong while reasoning about that request. Try again."),
          ],
        }));
      });
  },

  chooseOption: (option) => {
    const { pending, inspect, source } = get();
    if (!pending || !inspect || !source.length) return;
    set((s) => ({ messages: [...s.messages, say("user", option)], pending: null }));
    if (/cancel/i.test(option)) {
      set((s) => ({
        messages: [...s.messages, say("agent", "Cancelled. Tell me another slice whenever you're ready.")],
      }));
      return;
    }
    if (pending.resumePlan && /mixed or/i.test(option)) {
      const flat = pending.resumePlan.conditions;
      const orPlan: FilterGroup = { logic: "or", conditions: flat };
      const turn = acceptClarify(orPlan, source, inspect);
      set((s) => ({
        rows: turn.rows,
        result: turn.result,
        messages: [...s.messages, ...turn.messages],
      }));
      return;
    }
    if (pending.resumePlan) {
      const turn = acceptClarify(pending.resumePlan, source, inspect);
      set((s) => ({
        rows: turn.rows,
        result: turn.result,
        messages: [...s.messages, ...turn.messages],
      }));
      return;
    }
    get().send(option);
  },

  resetFilter: () => {
    const { source } = get();
    set({ rows: source, result: null });
    get().send("show all");
  },

  download: () => {
    const { rows, fileName } = get();
    const base = (fileName ?? "filtered").replace(/\.(xlsx|xls|xlsm|csv)$/i, "");
    downloadCsv(rows, `${base}_filtered.csv`);
  },
}));
