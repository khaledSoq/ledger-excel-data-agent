"""Shared types for the deterministic Excel filter / analysis engines."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

FilterOp = Literal[
    "eq",
    "ne",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "in",
    "not_in",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "is_null",
    "not_null",
    "year_eq",
    "year_between",
    "date_before",
    "date_after",
    "regex",
]

LogicOp = Literal["and", "or"]

ColumnKind = Literal[
    "id",
    "numeric_continuous",
    "numeric_discrete",
    "categorical",
    "boolean",
    "datetime",
    "text",
    "unknown",
]


VALID_OPS: frozenset[str] = frozenset(
    {
        "eq",
        "ne",
        "gt",
        "gte",
        "lt",
        "lte",
        "between",
        "in",
        "not_in",
        "contains",
        "not_contains",
        "starts_with",
        "ends_with",
        "is_null",
        "not_null",
        "year_eq",
        "year_between",
        "date_before",
        "date_after",
        "regex",
    }
)


@dataclass
class FilterCondition:
    column: str
    op: FilterOp
    value: Any = None

    def to_dict(self) -> dict[str, Any]:
        return {"column": self.column, "op": self.op, "value": self.value}


@dataclass
class FilterGroup:
    logic: LogicOp = "and"
    conditions: list[FilterCondition | FilterGroup] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "logic": self.logic,
            "conditions": [
                c.to_dict() if hasattr(c, "to_dict") else c for c in self.conditions
            ],
        }

    def flatten_leaves(self) -> list[FilterCondition]:
        leaves: list[FilterCondition] = []
        for item in self.conditions:
            if isinstance(item, FilterGroup):
                leaves.extend(item.flatten_leaves())
            else:
                leaves.append(item)
        return leaves


def _as_group(payload: dict[str, Any]) -> FilterGroup:
    logic = str(payload.get("logic", "and")).lower()
    if logic not in {"and", "or"}:
        logic = "and"
    items: list[FilterCondition | FilterGroup] = []
    raw_items = payload.get("conditions") or payload.get("filters") or []
    if isinstance(raw_items, dict):
        raw_items = [raw_items]
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        if "conditions" in item or "filters" in item or "logic" in item:
            items.append(_as_group(item))
        elif "column" in item and "op" in item:
            op = str(item["op"]).lower()
            if op not in VALID_OPS:
                raise ValueError(f"Unsupported operator: {item['op']}")
            items.append(
                FilterCondition(
                    column=str(item["column"]),
                    op=op,  # type: ignore[arg-type]
                    value=item.get("value"),
                )
            )
        else:
            raise ValueError(f"Invalid filter node: {item}")
    return FilterGroup(logic=logic, conditions=items)  # type: ignore[arg-type]


def parse_filter_plan(raw: Any) -> FilterGroup:
    """Parse a JSON string / dict into a FilterGroup.

    Accepts a single condition, a list of conditions (implicit AND), or a group.
    """
    import json

    if isinstance(raw, FilterGroup):
        return raw
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            raise ValueError("filter_conditions is empty")
        # Tolerate accidental markdown fences from small models.
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.strip()
        raw = json.loads(text)
    if isinstance(raw, list):
        return parse_filter_plan({"logic": "and", "conditions": raw})
    if isinstance(raw, dict):
        if "column" in raw and "op" in raw:
            return parse_filter_plan({"logic": "and", "conditions": [raw]})
        return _as_group(raw)
    raise ValueError("filter_conditions must be JSON (object or list)")


def json_safe(value: Any) -> Any:
    """Convert numpy / pandas / datetime values into JSON-serializable types."""
    from datetime import date, datetime
    from decimal import Decimal

    try:
        import numpy as np
        import pandas as pd
    except ImportError:  # pragma: no cover
        np = None  # type: ignore[assignment]
        pd = None  # type: ignore[assignment]

    if value is None:
        return None
    if isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return None
        return value
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if np is not None:
        if isinstance(value, np.integer):
            return int(value)
        if isinstance(value, np.floating):
            f = float(value)
            return None if f != f else f
        if isinstance(value, np.bool_):
            return bool(value)
        if isinstance(value, np.ndarray):
            return [json_safe(v) for v in value.tolist()]
    if pd is not None:
        if isinstance(value, pd.Timestamp):
            if pd.isna(value):
                return None
            return value.isoformat()
        try:
            if pd.isna(value):
                return None
        except (TypeError, ValueError):
            pass
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(v) for v in value]
    if hasattr(value, "item"):
        try:
            return json_safe(value.item())
        except Exception:
            pass
    return str(value)


def dataclass_to_dict(obj: Any) -> dict[str, Any]:
    return json_safe(asdict(obj))
