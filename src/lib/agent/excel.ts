import type { CellValue, DataRow } from "./types";

function excelSerialToIso(n: number): string | null {
  if (n < 20000 || n > 80000) return null;
  const utc = Date.UTC(1899, 11, 30) + n * 86400000;
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeCell(value: unknown): CellValue {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const iso = excelSerialToIso(value);
    // Leave serials as numbers here; date columns are detected later.
    // If it's clearly an Excel date serial AND has no fractional time we keep the number;
    // inspect/filter convert via asDate.
    return iso && value > 30000 && value < 60000 && Number.isInteger(value) ? iso : value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  return s === "" ? null : s;
}

export async function parseWorkbook(file: File): Promise<{ rows: DataRow[]; sheet: string; name: string }> {
  const XLSX = await import("xlsx");
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("The workbook has no sheets.");
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error("Could not read the first sheet.");
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true,
  });
  if (!raw.length) throw new Error("The sheet is empty.");
  const rows: DataRow[] = raw.map((row) => {
    const out: DataRow = {};
    for (const [k, v] of Object.entries(row)) {
      const key = String(k).trim() || "column";
      out[key] = normalizeCell(v);
    }
    return out;
  });
  return { rows, sheet: sheetName, name: file.name };
}

export function toCsv(rows: DataRow[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0] ?? {});
  const esc = (v: CellValue) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c] ?? null)).join(","))];
  return lines.join("\n");
}

export function downloadCsv(rows: DataRow[], filename = "filtered_output.csv") {
  const csv = toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
