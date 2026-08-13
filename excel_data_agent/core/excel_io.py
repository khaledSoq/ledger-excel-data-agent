"""Safe Excel / CSV I/O with size guards and path resolution."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd

from excel_data_agent.config import (
    MAX_FILE_BYTES,
    MAX_ROWS,
    OUTPUT_DIR,
    SAMPLES_DIR,
    UPLOAD_DIR,
    WORKSPACE_ROOT,
    ensure_directories,
)

ALLOWED_SUFFIXES = {".xlsx", ".xls", ".xlsm", ".csv"}


class ExcelAgentError(Exception):
    """Structured error raised by tools (converted to status=error dicts)."""

    def __init__(self, message: str, *, code: str = "error") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _safe_join(base: Path, name: str) -> Path:
    candidate = (base / name).resolve()
    if not str(candidate).startswith(str(base.resolve())):
        raise ExcelAgentError("Path escapes the allowed directory.", code="invalid_path")
    return candidate


def resolve_input_path(file_path: str) -> Path:
    """Resolve a user / LLM-supplied path against known data directories."""
    if not file_path or not str(file_path).strip():
        raise ExcelAgentError(
            "No file path provided. Upload an Excel file first, then inspect it.",
            code="missing_file",
        )
    raw = Path(str(file_path).strip())
    candidates: list[Path] = []
    if raw.is_absolute():
        candidates.append(raw)
    else:
        candidates.extend(
            [
                Path.cwd() / raw,
                UPLOAD_DIR / raw,
                UPLOAD_DIR / raw.name,
                SAMPLES_DIR / raw,
                SAMPLES_DIR / raw.name,
                WORKSPACE_ROOT / raw,
                OUTPUT_DIR / raw,
            ]
        )
    for cand in candidates:
        try:
            resolved = cand.resolve()
        except OSError:
            continue
        if resolved.is_file():
            _assert_allowed(resolved)
            return resolved
    raise ExcelAgentError(
        f"File not found: {file_path}. Use list_available_files to see uploads and samples.",
        code="file_not_found",
    )


def resolve_output_path(filename: str) -> Path:
    ensure_directories()
    name = Path(str(filename).strip() or "filtered_output.csv").name
    if not name.lower().endswith(".csv"):
        name = f"{name}.csv"
    return _safe_join(OUTPUT_DIR, name)


def _assert_allowed(path: Path) -> None:
    if path.suffix.lower() not in ALLOWED_SUFFIXES:
        raise ExcelAgentError(
            f"Unsupported file type '{path.suffix}'. Use .xlsx, .xls, or .csv.",
            code="unsupported_type",
        )
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ExcelAgentError(f"Cannot read file: {exc}", code="io_error") from exc
    if size > MAX_FILE_BYTES:
        mb = MAX_FILE_BYTES / (1024 * 1024)
        raise ExcelAgentError(
            f"File is too large ({size / (1024 * 1024):.1f} MB). Limit is {mb:.0f} MB.",
            code="file_too_large",
        )


def read_tabular(file_path: str | Path, *, nrows: int | None = None) -> pd.DataFrame:
    path = resolve_input_path(str(file_path))
    suffix = path.suffix.lower()
    try:
        if suffix == ".csv":
            df = pd.read_csv(path, nrows=nrows)
        else:
            df = pd.read_excel(path, engine="openpyxl" if suffix != ".xls" else None, nrows=nrows)
    except ExcelAgentError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ExcelAgentError(f"Failed to read '{path.name}': {exc}", code="read_error") from exc

    if df.empty and nrows is None:
        # Empty file is valid but unusual — caller decides.
        return df
    if len(df) > MAX_ROWS:
        raise ExcelAgentError(
            f"Sheet has {len(df):,} rows which exceeds the {MAX_ROWS:,} row safety limit.",
            code="too_many_rows",
        )
    # Normalize column names: strip whitespace, keep original mapping.
    df = df.copy()
    df.columns = [str(c).strip() if str(c).strip() else f"column_{i}" for i, c in enumerate(df.columns)]
    return df


def write_csv(df: pd.DataFrame, filename: str) -> Path:
    path = resolve_output_path(filename)
    df.to_csv(path, index=False)
    return path


def list_data_files() -> list[dict[str, Any]]:
    ensure_directories()
    found: list[dict[str, Any]] = []
    for folder, kind in ((UPLOAD_DIR, "upload"), (SAMPLES_DIR, "sample"), (OUTPUT_DIR, "output")):
        if not folder.exists():
            continue
        for path in sorted(folder.iterdir()):
            if not path.is_file() or path.suffix.lower() not in ALLOWED_SUFFIXES | {".csv"}:
                continue
            found.append(
                {
                    "name": path.name,
                    "path": str(path),
                    "kind": kind,
                    "suffix": path.suffix.lower(),
                    "bytes": path.stat().st_size,
                }
            )
    return found
