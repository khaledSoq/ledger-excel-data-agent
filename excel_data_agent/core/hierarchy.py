"""Filter hierarchy — decide AND/OR and which predicate to apply first.

Small models often AND everything, which hides data: a single over-tight
predicate can zero the result and the rest of the plan becomes invisible.
This module estimates selectivity and orders AND children from most
narrowing to least, so the trace shows *which* filter removed the rows.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from excel_data_agent.core.types import FilterCondition, FilterGroup


def estimate_selectivity(df: pd.DataFrame, item: FilterCondition | FilterGroup) -> float:
    """Estimated remaining fraction in [0, 1]. Lower = more narrowing."""
    if isinstance(item, FilterGroup):
        scores = [estimate_selectivity(df, c) for c in item.conditions] or [1.0]
        if item.logic == "and":
            # Independent-assumption product, floored.
            prod = 1.0
            for s in scores:
                prod *= max(s, 1e-6)
            return max(min(prod, 1.0), 0.0)
        # OR: 1 - Π(1-s)
        remain = 1.0
        for s in scores:
            remain *= max(1.0 - s, 0.0)
        return max(min(1.0 - remain, 1.0), 0.0)

    n = max(len(df), 1)
    col = item.column
    if col not in df.columns:
        return 0.5
    series = df[col]
    nn = series.dropna()
    n_unique = max(int(nn.nunique()), 1)
    op = item.op

    if op in {"eq"}:
        return min(1.0, 1.0 / n_unique)
    if op in {"ne"}:
        return min(1.0, max(0.0, 1.0 - 1.0 / n_unique))
    if op in {"in"}:
        k = len(item.value) if isinstance(item.value, list) else 1
        return min(1.0, k / n_unique)
    if op in {"not_in"}:
        k = len(item.value) if isinstance(item.value, list) else 1
        return min(1.0, max(0.0, 1.0 - k / n_unique))
    if op in {"between", "year_between"}:
        return 0.25
    if op in {"gt", "gte", "lt", "lte", "date_before", "date_after"}:
        return 0.40
    if op in {"year_eq"}:
        return 0.20
    if op in {"contains", "starts_with", "ends_with", "regex"}:
        return 0.30
    if op == "is_null":
        return float(series.isna().mean()) if n else 0.0
    if op == "not_null":
        return float(series.notna().mean()) if n else 0.0
    return 0.5


def order_and_children(
    df: pd.DataFrame, items: list[FilterCondition | FilterGroup]
) -> list[FilterCondition | FilterGroup]:
    """Most selective (lowest remaining fraction) first."""
    return sorted(items, key=lambda item: estimate_selectivity(df, item))


def recommend_strategy(df: pd.DataFrame, columns_meta: list[dict[str, Any]]) -> dict[str, Any]:
    """Tell the agent *how* to compose filters so it does not blindly AND/OR."""
    ranked = sorted(
        columns_meta,
        key=lambda c: (
            0 if c.get("kind") in {"categorical", "boolean", "datetime"} else 1,
            c.get("unique_ratio", 1.0),
        ),
    )
    order = [c["name"] for c in ranked]
    high_card = [
        c["name"]
        for c in columns_meta
        if c.get("kind") in {"id", "text"} or float(c.get("unique_ratio") or 0) > 0.6
    ]
    cats = [c["name"] for c in columns_meta if c.get("kind") == "categorical"]
    return {
        "recommended_filter_order": order,
        "apply_first": order[:3],
        "rationale": (
            "Apply high-selectivity categorical / date predicates first so you can "
            "see how many rows remain before tightening numeric ranges. "
            "Never AND multiple values of the *same* column (e.g. Department is "
            "Sales AND Department is Marketing) — that is always empty. Use OR or op=in. "
            "AND is for *different* dimensions (Department AND Age AND Status). "
            "If two ANDed predicates are each expected to keep <15% of rows, warn "
            "the user that the combination may be empty and ask before applying."
        ),
        "and_vs_or": {
            "use_and": "Different columns / independent dimensions.",
            "use_or": "Multiple acceptable values of one column, or alternative interpretations.",
            "never": "AND of mutually exclusive labels on the same column.",
        },
        "high_cardinality_avoid_eq": high_card,
        "same_column_multi_value": cats,
        "empty_result_risk": (
            "Product of per-predicate selectivities. If estimated remaining rows "
            "< 1, ask a clarifying question instead of applying the full AND."
        ),
    }
