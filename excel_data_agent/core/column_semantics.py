"""Infer column meaning, kind, and how it should be filtered."""

from __future__ import annotations

import re
from typing import Any

import pandas as pd

from excel_data_agent.config import CATEGORICAL_RATIO, CATEGORICAL_UNIQUE_CAP
from excel_data_agent.core.types import ColumnKind

_ID_RE = re.compile(
    r"(^id$|_id$|^id_|uuid|guid|pk$|primary.?key|employee.?id|user.?id|record.?id)",
    re.I,
)
_DATE_RE = re.compile(
    r"(date|time|timestamp|hired|start|end|dob|birth|created|updated|year|month)",
    re.I,
)
_BOOL_RE = re.compile(r"(is_|has_|active|flag|enabled|yes.?no|true.?false)", re.I)
_MONEY_RE = re.compile(
    r"(salary|wage|pay|price|cost|amount|revenue|fee|budget|income|spend)",
    re.I,
)
_AGE_RE = re.compile(r"(^age$|years.?old|tenure)", re.I)
_STATUS_RE = re.compile(r"(status|state|stage|phase)", re.I)
_DEPT_RE = re.compile(r"(dept|department|team|division|org|unit|function)", re.I)
_NAME_RE = re.compile(r"(name|first|last|full.?name|employee)", re.I)
_EMAIL_RE = re.compile(r"(email|e-mail)", re.I)
_GEO_RE = re.compile(r"(city|region|country|state|province|location|office)", re.I)
_SCORE_RE = re.compile(r"(score|rating|performance|grade|rank)", re.I)
_COUNT_RE = re.compile(r"(count|qty|quantity|n_|num_|number_of|headcount)", re.I)


def _non_null(series: pd.Series) -> pd.Series:
    return series.dropna()


def infer_kind(name: str, series: pd.Series) -> ColumnKind:
    n = len(series)
    nn = _non_null(series)
    n_unique = int(nn.nunique(dropna=True))
    unique_ratio = (n_unique / n) if n else 0.0

    if _ID_RE.search(name) and unique_ratio > 0.9:
        return "id"
    if pd.api.types.is_bool_dtype(series) or _looks_boolean(nn):
        return "boolean"
    if pd.api.types.is_datetime64_any_dtype(series) or _DATE_RE.search(name) and _looks_datetime(nn):
        return "datetime"
    if pd.api.types.is_numeric_dtype(series):
        if n_unique <= 2 and set(nn.unique()).issubset({0, 1, 0.0, 1.0}):
            return "boolean"
        if n_unique <= CATEGORICAL_UNIQUE_CAP and unique_ratio <= CATEGORICAL_RATIO * 2:
            return "numeric_discrete"
        return "numeric_continuous"
    # object / string
    if n_unique <= CATEGORICAL_UNIQUE_CAP or unique_ratio <= CATEGORICAL_RATIO:
        return "categorical"
    if _looks_datetime(nn):
        return "datetime"
    return "text"


def _looks_boolean(nn: pd.Series) -> bool:
    if nn.empty:
        return False
    values = {str(v).strip().lower() for v in nn.unique()[:12]}
    tokens = {
        "true",
        "false",
        "yes",
        "no",
        "y",
        "n",
        "0",
        "1",
        "t",
        "f",
        "active",
        "inactive",
    }
    return values.issubset(tokens) and 1 <= len(values) <= 3


def _looks_datetime(nn: pd.Series) -> bool:
    if nn.empty:
        return False
    if pd.api.types.is_datetime64_any_dtype(nn):
        return True
    sample = nn.astype(str).head(20)
    parsed = pd.to_datetime(sample, errors="coerce", format="mixed")
    return parsed.notna().mean() >= 0.7


def infer_meaning(name: str, kind: ColumnKind, series: pd.Series) -> str:
    nn = _non_null(series)
    n_unique = int(nn.nunique()) if len(nn) else 0
    if _AGE_RE.search(name):
        return "Age in years — numeric range filters (between / gt / lt) are appropriate."
    if _MONEY_RE.search(name):
        return "Monetary amount — compare with gt/lt/between. Watch currency units and outliers."
    if _STATUS_RE.search(name):
        return "Lifecycle / status flag — treat as categorical. Prefer eq / in, never range math."
    if _DEPT_RE.search(name):
        return "Organizational grouping — categorical. Multiple values of this column should use OR / in, not AND."
    if _EMAIL_RE.search(name):
        return "Email address — high-cardinality text. Filter with contains / eq, not numeric ops."
    if _GEO_RE.search(name):
        return "Geographic dimension — categorical. Combine with other columns using AND."
    if _SCORE_RE.search(name):
        return "Score / rating — numeric or ordinal. Range filters and anomaly checks apply."
    if _COUNT_RE.search(name):
        return "Count / quantity — discrete numeric. Consider Poisson-like distribution for analysis."
    if _DATE_RE.search(name) or kind == "datetime":
        return "Date / time — use year_eq, date_before, date_after, or between on ISO dates."
    if kind == "id":
        return "Identifier — almost unique per row. Filtering on a single id returns at most one record."
    if kind == "boolean":
        return "Boolean / yes-no flag — use eq with true/false (or the column's native labels)."
    if kind == "categorical":
        return f"Categorical field with {n_unique} distinct values. Use eq / in / not_in."
    if kind == "numeric_continuous":
        return "Continuous numeric measure — range filters and distribution / anomaly tools apply."
    if kind == "numeric_discrete":
        return "Low-cardinality numeric (codes or bins) — prefer in / eq over wide ranges."
    if kind == "text":
        return "Free text — use contains / starts_with. Do not treat as numeric."
    return "Column kind is unclear — inspect sample values before filtering."


def match_column(requested: str, columns: list[str]) -> str | None:
    """Resolve a user/LLM column name against the real header (never invent)."""
    if not requested:
        return None
    req = requested.strip()
    lower_map = {c.lower(): c for c in columns}
    if req in columns:
        return req
    if req.lower() in lower_map:
        return lower_map[req.lower()]
    compact = re.sub(r"[^a-z0-9]", "", req.lower())
    for c in columns:
        if re.sub(r"[^a-z0-9]", "", c.lower()) == compact:
            return c
    # Token containment (e.g. "dept" → "Department")
    hits = [c for c in columns if compact and compact in re.sub(r"[^a-z0-9]", "", c.lower())]
    if len(hits) == 1:
        return hits[0]
    # Unique prefix
    prefixes = [c for c in columns if c.lower().startswith(req.lower())]
    if len(prefixes) == 1:
        return prefixes[0]
    return None


def suggest_columns(requested: str, columns: list[str], *, limit: int = 5) -> list[str]:
    req = re.sub(r"[^a-z0-9]", "", (requested or "").lower())
    scored: list[tuple[int, str]] = []
    for c in columns:
        key = re.sub(r"[^a-z0-9]", "", c.lower())
        score = 0
        if req and req in key:
            score += 4
        if key.startswith(req):
            score += 3
        if req and any(ch in key for ch in req):
            score += 1
        if score:
            scored.append((score, c))
    scored.sort(key=lambda t: (-t[0], t[1]))
    return [c for _, c in scored[:limit]]


def coerce_value(series: pd.Series, value: Any) -> Any:
    """Coerce a filter value toward the column dtype without inventing data."""
    if value is None:
        return None
    if isinstance(value, list):
        return [coerce_value(series, v) for v in value]
    if pd.api.types.is_bool_dtype(series):
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "y", "t"}
        return bool(value)
    if pd.api.types.is_numeric_dtype(series):
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return value
        try:
            if isinstance(value, str) and value.strip() != "":
                num = float(value.replace(",", "").replace("$", "").strip())
                if num.is_integer() and not pd.api.types.is_float_dtype(series):
                    return int(num)
                return num
        except ValueError:
            return value
    if pd.api.types.is_datetime64_any_dtype(series):
        ts = pd.to_datetime(value, errors="coerce", format="mixed")
        return ts
    return value
