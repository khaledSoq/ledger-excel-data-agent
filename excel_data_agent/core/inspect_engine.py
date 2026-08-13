"""Inspect an Excel sheet: schema, samples, stats, quality, filter hierarchy."""

from __future__ import annotations

from typing import Any

import pandas as pd

from excel_data_agent.config import CATEGORICAL_UNIQUE_CAP, SAMPLE_HEAD
from excel_data_agent.core.column_semantics import infer_kind, infer_meaning
from excel_data_agent.core.hierarchy import recommend_strategy
from excel_data_agent.core.types import json_safe


def inspect_frame(df: pd.DataFrame, *, file_path: str = "") -> dict[str, Any]:
    columns_meta: list[dict[str, Any]] = []
    quality: list[dict[str, Any]] = []
    n = len(df)

    for name in df.columns:
        series = df[name]
        kind = infer_kind(str(name), series)
        nn = series.dropna()
        n_missing = int(series.isna().sum())
        n_unique = int(nn.nunique(dropna=True))
        unique_ratio = (n_unique / n) if n else 0.0
        meta: dict[str, Any] = {
            "name": str(name),
            "dtype": str(series.dtype),
            "kind": kind,
            "meaning": infer_meaning(str(name), kind, series),
            "n_unique": n_unique,
            "n_missing": n_missing,
            "missing_pct": round(100.0 * n_missing / n, 2) if n else 0.0,
            "unique_ratio": round(unique_ratio, 4),
            "sample_values": json_safe(_samples(nn)),
        }
        if kind in {"categorical", "boolean", "numeric_discrete"} or (
            n_unique <= CATEGORICAL_UNIQUE_CAP and kind not in {"id", "text", "datetime"}
        ):
            counts = nn.astype(str).value_counts().head(CATEGORICAL_UNIQUE_CAP)
            meta["unique_values"] = [str(v) for v in counts.index.tolist()]
            meta["value_counts"] = {str(k): int(v) for k, v in counts.items()}
        if kind in {"numeric_continuous", "numeric_discrete"} or pd.api.types.is_numeric_dtype(series):
            meta["stats"] = _numeric_stats(pd.to_numeric(nn, errors="coerce"))
        if kind == "datetime" or pd.api.types.is_datetime64_any_dtype(series):
            dates = pd.to_datetime(nn, errors="coerce", format="mixed").dropna()
            if not dates.empty:
                meta["stats"] = {
                    "min": dates.min().isoformat(),
                    "max": dates.max().isoformat(),
                    "n": int(len(dates)),
                }
        meta["filter_priority"] = _priority(kind, unique_ratio, n_unique)
        meta["selectivity_hint"] = _selectivity_hint(kind, n_unique, unique_ratio)
        columns_meta.append(meta)

        if n_missing / n > 0.2 if n else False:
            quality.append(
                {
                    "column": str(name),
                    "issue": "high_missingness",
                    "detail": f"{meta['missing_pct']}% missing — filters on this column silently drop rows.",
                }
            )
        if n and n_unique == 1:
            quality.append(
                {
                    "column": str(name),
                    "issue": "constant",
                    "detail": "Only one distinct value — filtering here does not change visibility.",
                }
            )
        if kind == "id" and unique_ratio > 0.98:
            quality.append(
                {
                    "column": str(name),
                    "issue": "identifier",
                    "detail": "Nearly unique. Equality filters return at most one row.",
                }
            )

    # Duplicate rows
    dup = int(df.duplicated().sum())
    if dup:
        quality.append(
            {
                "column": "*",
                "issue": "duplicate_rows",
                "detail": f"{dup} exact duplicate row(s).",
            }
        )

    strategy = recommend_strategy(df, columns_meta)
    sample_rows = json_safe(df.head(SAMPLE_HEAD).to_dict(orient="records"))

    return json_safe(
        {
            "status": "success",
            "file_path": file_path,
            "n_rows": int(n),
            "n_cols": int(df.shape[1]),
            "columns": columns_meta,
            "column_names": [str(c) for c in df.columns],
            "sample_rows": sample_rows,
            "filter_strategy": strategy,
            "data_quality": quality,
            "instruction_for_agent": (
                "Use ONLY these column names. Do not invent columns. "
                "Compose filters as a FilterGroup JSON. "
                "AND across different dimensions; OR / in for multiple values of one column. "
                "If the request is ambiguous (unclear column, unknown label, or a combination "
                "likely to return 0 rows), ASK a clarifying question before calling filter_excel."
            ),
        }
    )


def _samples(nn: pd.Series, k: int = 5) -> list[Any]:
    if nn.empty:
        return []
    return nn.head(k).tolist()


def _numeric_stats(nn: pd.Series) -> dict[str, Any]:
    clean = nn.dropna()
    if clean.empty:
        return {}
    q1 = float(clean.quantile(0.25))
    q3 = float(clean.quantile(0.75))
    return {
        "count": int(len(clean)),
        "min": float(clean.min()),
        "max": float(clean.max()),
        "mean": float(clean.mean()),
        "median": float(clean.median()),
        "std": float(clean.std(ddof=1)) if len(clean) > 1 else 0.0,
        "q1": q1,
        "q3": q3,
        "iqr": q3 - q1,
        "skew": float(clean.skew()) if len(clean) > 2 else 0.0,
    }


def _priority(kind: str, unique_ratio: float, n_unique: int) -> int:
    """1 = apply first (most useful for visibility)."""
    if kind in {"categorical", "boolean"}:
        return 1
    if kind == "datetime":
        return 2
    if kind in {"numeric_discrete", "numeric_continuous"}:
        return 3
    if kind == "text":
        return 4
    if kind == "id":
        return 5
    return 4


def _selectivity_hint(kind: str, n_unique: int, unique_ratio: float) -> str:
    if kind == "id":
        return "Very high selectivity — equality returns ~1 row. Do not AND with other tight filters unless the user asked for a specific id."
    if kind == "categorical":
        return (
            f"{n_unique} labels. Filtering to one label keeps ~{100.0 / max(n_unique, 1):.1f}% "
            "if balanced. Multiple labels → use op=in (OR), never AND."
        )
    if kind == "boolean":
        return "Two-way split. Safe to AND with other dimensions."
    if kind == "datetime":
        return "Year / range filters are medium selectivity. Apply after categorical cuts so remaining dates stay visible."
    if kind in {"numeric_continuous", "numeric_discrete"}:
        return "Range filters are medium selectivity. Apply after categorical / status cuts."
    if kind == "text":
        return "contains is unpredictable. Preview row counts before combining with AND."
    return "Inspect sample values before filtering."
