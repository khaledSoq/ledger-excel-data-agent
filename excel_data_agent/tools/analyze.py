"""Higher-level analysis tools: summary, meaning, anomalies, distributions."""

from __future__ import annotations

from typing import Any

import pandas as pd

from excel_data_agent.core.anomalies import FORMULAS, analyze_anomalies
from excel_data_agent.core.column_semantics import infer_kind, infer_meaning, match_column
from excel_data_agent.core.distributions import FAMILIES, analyze_distributions
from excel_data_agent.core.excel_io import ExcelAgentError, read_tabular
from excel_data_agent.core.inspect_engine import inspect_frame
from excel_data_agent.core.types import json_safe
from excel_data_agent.tools._context import error_dict, resolve_file_path, state_get

try:
    from google.adk.tools import ToolContext
except ImportError:  # pragma: no cover
    ToolContext = Any  # type: ignore[misc, assignment]


def analyze_data(
    file_path: str = "",
    focus: str = "summary",
    column: str = "",
    tool_context: ToolContext | None = None,
) -> dict[str, Any]:
    """High-level insights about the current (or last-filtered) table.

    focus:
      - summary       — shape, missingness, numeric snapshot, correlations
      - column_meaning — what a column (or every column) represents
      - quality       — data-quality issues
      - correlations  — Pearson correlations for numeric columns
      - all           — everything above

    For anomalies use detect_anomalies. For distribution fitting use
    explain_distribution. Prefer those specialised tools when the user asks
    "are there outliers?" or "what distribution is this?".

    Args:
        file_path: Workbook path. Empty → last output CSV if present, else current file.
        focus: One of summary | column_meaning | quality | correlations | all.
        column: Optional single column to zoom in on.
    """
    path = _preferred_path(file_path, tool_context)
    try:
        df = read_tabular(path)
        payload = _analyze(df, focus=focus, column=column)
    except (ExcelAgentError, ValueError, OSError) as exc:
        return error_dict(exc)
    payload["file_path"] = path
    return payload


def detect_anomalies(
    file_path: str = "",
    column: str = "",
    tool_context: ToolContext | None = None,
) -> dict[str, Any]:
    """Find anomalies with documented formulas (IQR, z-score, modified z, rare labels).

    Method is chosen from the column's shape — see the returned `formulas`
    and `method_selection` fields. Explain those formulas to the user.

    Args:
        file_path: Workbook / last CSV. Empty uses session state.
        column: Optional column to analyse. Empty = every suitable column.
    """
    path = _preferred_path(file_path, tool_context)
    try:
        df = read_tabular(path)
        cols = [column] if column.strip() else None
        report = analyze_anomalies(df, columns=cols)
    except (ExcelAgentError, ValueError, OSError) as exc:
        return error_dict(exc)
    report["file_path"] = path
    return report


def explain_distribution(
    file_path: str = "",
    column: str = "",
    tool_context: ToolContext | None = None,
) -> dict[str, Any]:
    """Recommend a probability family for numeric columns and show the PDF/PMF.

    Selection rules (also returned in the payload):
      counts + var≈mean → Poisson
      flat + platykurtic → Uniform
      positive + CV≈1 → Exponential
      positive + ln(x) closer to normal → Lognormal
      other positive skew → Gamma
      |skew|<0.5 → Normal
      else Empirical

    Args:
        file_path: Workbook / last CSV.
        column: Optional column. Empty = every numeric column.
    """
    path = _preferred_path(file_path, tool_context)
    try:
        df = read_tabular(path)
        cols = [column] if column.strip() else None
        report = analyze_distributions(df, columns=cols)
    except (ExcelAgentError, ValueError, OSError) as exc:
        return error_dict(exc)
    report["file_path"] = path
    return report


def _preferred_path(file_path: str, tool_context: Any) -> str:
    path = (file_path or "").strip()
    if path:
        return path
    last = state_get(tool_context, "last_output", "")
    if last:
        return str(last)
    current = state_get(tool_context, "current_file", "")
    return str(current or "")


def _analyze(df: pd.DataFrame, *, focus: str, column: str) -> dict[str, Any]:
    focus_n = (focus or "summary").strip().lower()
    out: dict[str, Any] = {"status": "success", "focus": focus_n, "n_rows": int(len(df))}
    inspected = inspect_frame(df)

    if column.strip():
        real = match_column(column, [str(c) for c in df.columns])
        if real is None:
            return {
                "status": "error",
                "error_code": "unknown_column",
                "error_message": f"Unknown column '{column}'. Known: {', '.join(map(str, df.columns))}",
            }
        series = df[real]
        kind = infer_kind(real, series)
        out["column"] = {
            "name": real,
            "kind": kind,
            "meaning": infer_meaning(real, kind, series),
            "meta": next((c for c in inspected["columns"] if c["name"] == real), None),
        }

    if focus_n in {"summary", "all"}:
        out["summary"] = {
            "n_rows": inspected["n_rows"],
            "n_cols": inspected["n_cols"],
            "column_names": inspected["column_names"],
            "numeric_snapshot": [
                {"name": c["name"], "stats": c.get("stats")}
                for c in inspected["columns"]
                if c.get("stats") and isinstance(c.get("stats"), dict) and "mean" in c["stats"]
            ],
            "missing": [
                {"name": c["name"], "n_missing": c["n_missing"], "missing_pct": c["missing_pct"]}
                for c in inspected["columns"]
                if c["n_missing"]
            ],
        }
    if focus_n in {"column_meaning", "all"}:
        out["column_meaning"] = [
            {"name": c["name"], "kind": c["kind"], "meaning": c["meaning"]}
            for c in inspected["columns"]
        ]
    if focus_n in {"quality", "all"}:
        out["data_quality"] = inspected["data_quality"]
    if focus_n in {"correlations", "all"}:
        out["correlations"] = _correlations(df)
    out["formulas_available"] = {
        "anomalies": FORMULAS,
        "distributions": FAMILIES,
    }
    return json_safe(out)


def _correlations(df: pd.DataFrame) -> list[dict[str, Any]]:
    num = df.select_dtypes(include="number")
    if num.shape[1] < 2:
        return []
    corr = num.corr(numeric_only=True)
    pairs: list[dict[str, Any]] = []
    cols = list(corr.columns)
    for i, a in enumerate(cols):
        for b in cols[i + 1 :]:
            val = corr.loc[a, b]
            if pd.isna(val):
                continue
            pairs.append({"a": str(a), "b": str(b), "r": float(val)})
    pairs.sort(key=lambda p: abs(p["r"]), reverse=True)
    return pairs[:20]
