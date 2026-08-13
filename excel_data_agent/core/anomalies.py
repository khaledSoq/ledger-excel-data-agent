"""Anomaly detection with explicit, documented formulas.

The agent must be able to *explain* which rule fired and why that rule
was chosen for the column's shape.

Formulas
--------
1. Tukey IQR fences
       IQR  = Q3 − Q1
       low  = Q1 − k · IQR
       high = Q3 + k · IQR
   Mild outliers use k = 1.5; extreme outliers use k = 3.
   Robust to non-normality. Default when n is small or the shape is unknown.

2. Classical z-score
       z_i = (x_i − μ) / σ
   Flag |z| > τ  (default τ = 3, i.e. the 99.7% rule under normality).
   Only valid when the bulk is approximately Gaussian *and* σ is not
   itself inflated by the outliers we are trying to find.

3. Modified z-score (Iglewicz & Hoaglin)
       MAD  = median(|x_i − median(x)|)
       M_i  = 0.6745 · (x_i − median(x)) / MAD
   Flag |M| > 3.5.
   The constant 0.6745 is Φ⁻¹(0.75), so E[MAD] ≈ 0.6745 σ for a normal.
   Preferred when the distribution is skewed or already contaminated.

4. Rare-category rule (categorical)
       p̂_j = n_j / n
   Flag label j when p̂_j < α  (default α = 0.01) and n_j ≤ 3, or when
   n_j = 1 (singleton).

Method selection
----------------
- n < 12                         → IQR only (z/MAD are unstable)
- roughly normal (|skew| < 0.5 and |excess kurtosis| < 1) → z-score + IQR
- skewed / heavy-tailed          → modified z-score + IQR
- categorical / boolean          → rare-category rule
- mixed / unknown                → IQR (safest default)
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from excel_data_agent.core.column_semantics import infer_kind, match_column
from excel_data_agent.core.types import json_safe

FORMULAS = {
    "iqr": {
        "name": "Tukey IQR fences",
        "formula": "IQR = Q3 - Q1; fence = Q1 - k·IQR , Q3 + k·IQR  (k=1.5 mild, k=3 extreme)",
        "when": "Default. Small n, unknown shape, or as a second opinion next to z/MAD.",
    },
    "zscore": {
        "name": "Classical z-score",
        "formula": "z = (x - μ) / σ   flag |z| > 3",
        "when": "Bulk of the column is approximately normal and not yet contaminated.",
    },
    "modified_z": {
        "name": "Modified z-score (Iglewicz–Hoaglin)",
        "formula": "M = 0.6745 · (x - median) / MAD   flag |M| > 3.5",
        "when": "Skewed or already-contaminated numeric data. More robust than z.",
    },
    "rare_category": {
        "name": "Rare-category frequency",
        "formula": "p̂ = n_j / n   flag p̂ < 0.01 (or n_j = 1)",
        "when": "Categorical / status / department labels.",
    },
}


def choose_method(kind: str, values: np.ndarray) -> str:
    n = values.size
    if kind in {"categorical", "boolean", "text", "id"}:
        return "rare_category"
    if n < 12:
        return "iqr"
    if n < 3:
        return "iqr"
    skew = float(pd.Series(values).skew())
    kurt = float(pd.Series(values).kurtosis())  # excess kurtosis
    if abs(skew) < 0.5 and abs(kurt) < 1.0:
        return "zscore"
    return "modified_z"


def analyze_anomalies(
    df: pd.DataFrame,
    *,
    columns: list[str] | None = None,
    z_threshold: float = 3.0,
    modified_z_threshold: float = 3.5,
    iqr_k: float = 1.5,
    rare_alpha: float = 0.01,
) -> dict[str, Any]:
    names = columns or [str(c) for c in df.columns]
    reports: list[dict[str, Any]] = []
    flagged_idx: set[int] = set()

    for raw_name in names:
        real = match_column(raw_name, [str(c) for c in df.columns])
        if real is None:
            reports.append(
                {
                    "column": raw_name,
                    "status": "error",
                    "error": f"Unknown column '{raw_name}'.",
                }
            )
            continue
        series = df[real]
        kind = infer_kind(real, series)
        method = choose_method(kind, _numeric_values(series))
        if method == "rare_category" or kind in {"categorical", "boolean", "text", "id"}:
            report = _rare_categories(df, real, series, rare_alpha)
        else:
            report = _numeric_anomalies(
                df,
                real,
                series,
                method=method,
                z_threshold=z_threshold,
                modified_z_threshold=modified_z_threshold,
                iqr_k=iqr_k,
            )
        reports.append(report)
        for rec in report.get("records") or []:
            if rec.get("row_index") is not None:
                flagged_idx.add(int(rec["row_index"]))

    return json_safe(
        {
            "status": "success",
            "n_rows_flagged": len(flagged_idx),
            "formulas": FORMULAS,
            "method_selection": (
                "n<12 → IQR; |skew|<0.5 and |excess kurtosis|<1 → z-score; "
                "otherwise modified z; categorical → rare labels."
            ),
            "columns": reports,
        }
    )


def _numeric_values(series: pd.Series) -> np.ndarray:
    num = pd.to_numeric(series, errors="coerce").dropna().to_numpy(dtype=float)
    return num


def _numeric_anomalies(
    df: pd.DataFrame,
    name: str,
    series: pd.Series,
    *,
    method: str,
    z_threshold: float,
    modified_z_threshold: float,
    iqr_k: float,
) -> dict[str, Any]:
    num = pd.to_numeric(series, errors="coerce")
    clean = num.dropna()
    values = clean.to_numpy(dtype=float)
    n = values.size
    if n < 4:
        return {
            "column": name,
            "method": method,
            "status": "skipped",
            "reason": "Need at least 4 numeric values.",
            "formula": FORMULAS.get(method),
            "records": [],
        }

    q1, q3 = np.quantile(values, [0.25, 0.75])
    iqr = float(q3 - q1)
    low, high = float(q1 - iqr_k * iqr), float(q3 + iqr_k * iqr)
    mu, sigma = float(values.mean()), float(values.std(ddof=1)) if n > 1 else 0.0
    med = float(np.median(values))
    mad = float(np.median(np.abs(values - med)))

    records: list[dict[str, Any]] = []
    for idx, raw in num.items():
        if pd.isna(raw):
            continue
        x = float(raw)
        z = (x - mu) / sigma if sigma > 0 else 0.0
        mz = (0.6745 * (x - med) / mad) if mad > 0 else 0.0
        reasons: list[str] = []
        if x < low or x > high:
            reasons.append("iqr")
        if method == "zscore" and abs(z) > z_threshold:
            reasons.append("zscore")
        if method == "modified_z" and abs(mz) > modified_z_threshold:
            reasons.append("modified_z")
        # Always keep IQR as a safety net alongside the chosen method.
        if not reasons:
            continue
        records.append(
            {
                "row_index": int(idx) if isinstance(idx, (int, np.integer)) else idx,
                "value": x,
                "z": round(z, 3),
                "modified_z": round(mz, 3),
                "outside_iqr_fence": bool(x < low or x > high),
                "reasons": reasons,
            }
        )

    records.sort(key=lambda r: abs(r["modified_z"] if method == "modified_z" else r["z"]), reverse=True)
    return {
        "column": name,
        "method": method,
        "why_this_method": FORMULAS[method]["when"] if method in FORMULAS else "",
        "formula": FORMULAS.get(method),
        "params": {
            "n": n,
            "mean": mu,
            "std": sigma,
            "median": med,
            "mad": mad,
            "q1": float(q1),
            "q3": float(q3),
            "iqr": iqr,
            "iqr_low": low,
            "iqr_high": high,
            "z_threshold": z_threshold,
            "modified_z_threshold": modified_z_threshold,
        },
        "n_flagged": len(records),
        "records": records[:50],
    }


def _rare_categories(
    df: pd.DataFrame, name: str, series: pd.Series, alpha: float
) -> dict[str, Any]:
    nn = series.dropna().astype(str)
    n = len(nn)
    if n == 0:
        return {
            "column": name,
            "method": "rare_category",
            "formula": FORMULAS["rare_category"],
            "n_flagged": 0,
            "records": [],
        }
    counts = nn.value_counts()
    rare = []
    for label, cnt in counts.items():
        p = float(cnt) / n
        if p < alpha or int(cnt) == 1:
            rare.append({"label": str(label), "count": int(cnt), "share": round(p, 4)})
    records = []
    rare_labels = {r["label"] for r in rare}
    if rare_labels:
        for idx, val in series.items():
            if pd.isna(val):
                continue
            if str(val) in rare_labels:
                records.append(
                    {
                        "row_index": int(idx) if isinstance(idx, (int, np.integer)) else idx,
                        "value": str(val),
                        "reasons": ["rare_category"],
                    }
                )
    return {
        "column": name,
        "method": "rare_category",
        "why_this_method": FORMULAS["rare_category"]["when"],
        "formula": FORMULAS["rare_category"],
        "rare_labels": rare,
        "n_flagged": len(records),
        "records": records[:50],
    }
