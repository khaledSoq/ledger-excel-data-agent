"""list_available_files and export_to_csv helpers."""

from __future__ import annotations

from typing import Any

from excel_data_agent.core.excel_io import (
    ExcelAgentError,
    list_data_files,
    read_tabular,
    write_csv,
)
from excel_data_agent.tools._context import error_dict, resolve_file_path, state_set

try:
    from google.adk.tools import ToolContext
except ImportError:  # pragma: no cover
    ToolContext = Any  # type: ignore[misc, assignment]


def list_available_files(tool_context: ToolContext | None = None) -> dict[str, Any]:
    """List Excel/CSV files in the uploads, samples, and outputs folders.

    Use this when the user has not given a path, or to confirm a file landed
    after an ADK Web upload.
    """
    del tool_context
    files = list_data_files()
    return {
        "status": "success",
        "n_files": len(files),
        "files": files,
        "hint": "Pass one of the `path` values to inspect_excel.",
    }


def export_to_csv(
    file_path: str = "",
    output_filename: str = "export.csv",
    tool_context: ToolContext | None = None,
) -> dict[str, Any]:
    """Export the current table (or a named file) to CSV without filtering.

    Args:
        file_path: Source path. Empty → session current file.
        output_filename: Destination CSV name.
    """
    path = resolve_file_path(file_path, tool_context)
    try:
        df = read_tabular(path)
        out = write_csv(df, output_filename)
    except (ExcelAgentError, ValueError, OSError) as exc:
        return error_dict(exc)
    state_set(tool_context, "last_output", str(out))
    return {
        "status": "success",
        "output_path": str(out),
        "output_filename": out.name,
        "n_rows": int(len(df)),
        "n_cols": int(df.shape[1]),
    }
