"""Deterministic English → FilterGroup.

Mirrors the browser parser. Same-column ORs stay grouped; different
dimensions are AND. “Inactive or On Leave from Finance or HR” is
(Status in {Inactive, On Leave}) AND (Department in {Finance, HR}).
"""

from __future__ import annotations

import re
from typing import Any

from excel_data_agent.core.types import FilterCondition, FilterGroup

_CROSS_AND = re.compile(
    r"\b(from|in|within|among|of|who are|that are|employees?|people|staff|records?|rows?)\b",
    re.I,
)
_WORD = re.compile(r"[A-Za-z0-9]+")


def _escape(s: str) -> str:
    return re.escape(s)


def extract_label_hits(text: str, columns_meta: list[dict[str, Any]]) -> list[dict[str, Any]]:
    catalog: list[tuple[str, str]] = []
    for col in columns_meta:
        if col.get("kind") in {"id", "text"}:
            continue
        values = col.get("unique_values") or col.get("uniqueValues") or []
        if len(values) > 80:
            continue
        for value in values:
            if value and len(str(value)) >= 2:
                catalog.append((col["name"], str(value)))
    catalog.sort(key=lambda t: -len(t[1]))

    lower = text.lower()
    taken: list[tuple[int, int]] = []
    hits: list[dict[str, Any]] = []

    def overlaps(s: int, e: int) -> bool:
        return any(s < b and e > a for a, b in taken)

    for column, value in catalog:
        needle = value.lower()
        for m in re.finditer(rf"\b{_escape(needle)}\b", lower):
            s, e = m.start(), m.end()
            if overlaps(s, e):
                continue
            taken.append((s, e))
            hits.append({"column": column, "value": value, "start": s, "end": e})
    hits.sort(key=lambda h: h["start"])
    return hits


def parse_natural_language(prompt: str, inspect: dict[str, Any]) -> dict[str, Any]:
    columns = inspect.get("columns") or []
    hits = extract_label_hits(prompt, columns)
    by_col: dict[str, list[str]] = {}
    for h in hits:
        by_col.setdefault(h["column"], [])
        if h["value"] not in by_col[h["column"]]:
            by_col[h["column"]].append(h["value"])

    conditions: list[FilterCondition | FilterGroup] = []
    for col, vals in by_col.items():
        if len(vals) == 1:
            conditions.append(FilterCondition(column=col, op="eq", value=vals[0]))
        else:
            conditions.append(FilterCondition(column=col, op="in", value=vals))

    if not conditions:
        return {"ok": False, "error": "no_conditions"}

    plan = FilterGroup(logic="and", conditions=conditions)
    return {"ok": True, "plan": plan.to_dict()}
