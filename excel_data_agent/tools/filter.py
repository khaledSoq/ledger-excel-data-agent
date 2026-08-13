"""filter_excel and preview_filter FunctionTools."""

from __future__ import annotations

from typing import Any

from excel_data_agent.core.excel_io import ExcelAgentError, read_tabular, write_csv
from excel_data_agent.core.filter_engine import apply_plan, preview_dict
from excel_data_agent.tools._context import error_dict, resolve_file_path, state_set

try:
    from google.adk.tools import ToolContext
except ImportError:  # pragma: no cover
    ToolContext = Any  # type: ignore[misc, assignment]


_FILTER_DOC = """
filter_conditions MUST be a JSON string of a FilterGroup (never pandas code):

{
  "logic": "and" | "or",
  "conditions": [
    {"column": "<exact header>", "op": "<op>", "value": <scalar|list>},
    ...
  ]
}

Operators:
  eq, ne, gt, gte, lt, lte, between, in, not_in,
  contains, not_contains, starts_with, ends_with,
  is_null, not_null, year_eq, year_between, date_before, date_after, regex

Rules:
  - column must be an exact name from inspect_excel (case-insensitive match is ok).
  - AND across *different* columns. OR / op=in for multiple values of the SAME column.
  - between and year_between take value [min, max].
  - year_eq takes a 4-digit year and works on date columns.
  - Do not emit mutually exclusive ANDs (Department=Sales AND Department=Marketing).
"""


def filter_excel(
    file_path: str,
    filter_conditions: str,
    output_filename: str = "filtered_output.csv",
    tool_context: ToolContext | None = None,
) -> dict[str, Any]:
    """Apply a structured filter plan to an Excel file and save matching rows as CSV.

    Translate the user's natural-language request into FilterGroup JSON, then
    call this tool. The engine applies AND predicates in selectivity order
    (most narrowing first) so the returned `trace` shows which condition
    affected visibility.

    Returns the CSV path, match count, a short summary, a sample of rows,
    and the execution trace.

    Args:
        file_path: Path to the source Excel/CSV. Empty → session current file.
        filter_conditions: JSON string of a FilterGroup (see schema in docstring).
        output_filename: Destination CSV name (written under the outputs directory).
    """
    path = resolve_file_path(file_path, tool_context)
    try:
        df = read_tabular(path)
        result = apply_plan(df, filter_conditions)
        out = write_csv(result["frame"], output_filename)
    except (ExcelAgentError, ValueError, OSError) as exc:
        return error_dict(exc)

    payload = preview_dict(result)
    payload["output_path"] = str(out)
    payload["output_filename"] = out.name
    payload["source_path"] = path
    state_set(tool_context, "current_file", path)
    state_set(tool_context, "last_filter", payload.get("plan"))
    state_set(tool_context, "last_output", str(out))
    state_set(tool_context, "last_match_count", payload.get("n_matched"))
    return payload


def preview_filter(
    file_path: str,
    filter_conditions: str,
    tool_context: ToolContext | None = None,
) -> dict[str, Any]:
    """Dry-run a filter plan without writing a CSV.

    Use this when the combination looks aggressive (several tight ANDs) or
    the user might have meant OR. Returns the same match count, summary,
    sample, and hierarchy trace as filter_excel.

    Args:
        file_path: Source workbook. Empty → session current file.
        filter_conditions: JSON FilterGroup string.
    """
    path = resolve_file_path(file_path, tool_context)
    try:
        df = read_tabular(path)
        result = apply_plan(df, filter_conditions)
    except (ExcelAgentError, ValueError, OSError) as exc:
        return error_dict(exc)
    payload = preview_dict(result)
    payload["source_path"] = path
    payload["wrote_file"] = False
    return payload


# Extra prose attached for the LLM via the module docstring / instruction.
filter_excel.__doc__ = (filter_excel.__doc__ or "") + _FILTER_DOC
preview_filter.__doc__ = (preview_filter.__doc__ or "") + _FILTER_DOC
