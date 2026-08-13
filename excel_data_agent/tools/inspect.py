"""inspect_excel FunctionTool."""

from __future__ import annotations

from typing import Any

from excel_data_agent.core.excel_io import ExcelAgentError, read_tabular
from excel_data_agent.core.inspect_engine import inspect_frame
from excel_data_agent.tools._context import error_dict, resolve_file_path, state_set

try:
    from google.adk.tools import ToolContext
except ImportError:  # pragma: no cover - ADK not installed in unit tests
    ToolContext = Any  # type: ignore[misc, assignment]


def inspect_excel(file_path: str = "", tool_context: ToolContext | None = None) -> dict[str, Any]:
    """Inspect an Excel/CSV file before any filtering.

    Call this FIRST when a new file is uploaded or mentioned. Returns real
    column names, dtypes, sample rows, numeric stats, categorical uniques,
    data-quality issues, and a filter hierarchy (which column to cut first
    so AND/OR does not hide the rest of the data).

    Never invent column names after this — use only the names in `column_names`.

    Args:
        file_path: Absolute or relative path to .xlsx / .xls / .csv. Leave
            empty to reuse the file already stored in session state.
    """
    path = resolve_file_path(file_path, tool_context)
    try:
        df = read_tabular(path)
        report = inspect_frame(df, file_path=path)
    except (ExcelAgentError, ValueError, OSError) as exc:
        return error_dict(exc)
    state_set(tool_context, "current_file", report.get("file_path") or path)
    state_set(tool_context, "schema", report)
    state_set(tool_context, "column_names", report.get("column_names"))
    return report
