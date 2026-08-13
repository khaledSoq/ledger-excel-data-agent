export type FilterOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "in"
  | "not_in"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_null"
  | "not_null"
  | "year_eq"
  | "year_between"
  | "date_before"
  | "date_after"
  | "regex";

export type LogicOp = "and" | "or";

export type ColumnKind =
  | "id"
  | "numeric_continuous"
  | "numeric_discrete"
  | "categorical"
  | "boolean"
  | "datetime"
  | "text"
  | "unknown";

export type CellValue = string | number | boolean | null;

export type DataRow = Record<string, CellValue>;

export type FilterCondition = {
  column: string;
  op: FilterOp;
  value?: unknown;
};

export type FilterGroup = {
  logic: LogicOp;
  conditions: Array<FilterCondition | FilterGroup>;
};

export function isGroup(node: FilterCondition | FilterGroup): node is FilterGroup {
  return "logic" in node && Array.isArray((node as FilterGroup).conditions);
}

export type ColumnMeta = {
  name: string;
  dtype: string;
  kind: ColumnKind;
  meaning: string;
  nUnique: number;
  nMissing: number;
  missingPct: number;
  uniqueRatio: number;
  sampleValues: CellValue[];
  uniqueValues?: string[];
  valueCounts?: Record<string, number>;
  stats?: Record<string, number | string>;
  filterPriority: number;
  selectivityHint: string;
};

export type InspectReport = {
  nRows: number;
  nCols: number;
  columns: ColumnMeta[];
  columnNames: string[];
  sampleRows: DataRow[];
  filterStrategy: {
    recommendedFilterOrder: string[];
    applyFirst: string[];
    rationale: string;
    andVsOr: { useAnd: string; useOr: string; never: string };
  };
  dataQuality: Array<{ column: string; issue: string; detail: string }>;
};

export type FilterTrace = {
  path: string;
  logic: LogicOp;
  order?: number;
  predicate?: FilterCondition | FilterGroup;
  estimatedSelectivity?: number;
  rowsBefore?: number;
  rowsAfter?: number;
  dropped?: number;
  emptiedResult?: boolean;
  note?: string;
  addedRows?: number;
  child?: FilterTrace[];
};

export type FilterResult = {
  rows: DataRow[];
  nInput: number;
  nMatched: number;
  nDropped: number;
  plan: FilterGroup;
  trace: FilterTrace[];
  empty: boolean;
  summary: string;
};

export type ClarifyQuestion = {
  question: string;
  options?: string[];
};

export type ChatRole = "agent" | "user" | "system";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  at: number;
  plan?: FilterGroup;
  insights?: string[];
};
