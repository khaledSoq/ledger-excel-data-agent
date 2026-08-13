"""Deterministic pandas filter engine.

The LLM never writes pandas code. It emits a FilterGroup JSON document; this
module resolves column names against the real header and applies operators.
AND groups are executed in selectivity order so the first predicate that
collapses the set is visible — that is the hierarchy of data visibility.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from excel_data_agent.core.column_semantics import coerce_value, match_column, suggest_columns
from excel_data_agent.core.hierarchy import estimate_selectivity, order_and_children
from excel_data_agent.core.types import FilterCondition, FilterGroup, json_safe, parse_filter_plan


def apply_plan(
    df: pd.DataFrame,
    plan: FilterGroup | dict[str, Any] | str,
) -> dict[str, Any]:
    group = parse_filter_plan(plan)
    columns = [str(c) for c in df.columns]
    resolved = _resolve_group(group, columns)
    mask, trace = _apply_group(df, resolved, path="root")
    filtered = df.loc[mask].copy()
    return {
        "status": "success",
        "n_input": int(len(df)),
        "n_matched": int(len(filtered)),
        "n_dropped": int(len(df) - len(filtered)),
        "plan": resolved.to_dict(),
        "trace": trace,
        "empty": bool(filtered.empty),
        "frame": filtered,
    }


def _resolve_group(group: FilterGroup, columns: list[str]) -> FilterGroup:
    resolved: list[FilterCondition | FilterGroup] = []
    for item in group.conditions:
        if isinstance(item, FilterGroup):
            resolved.append(_resolve_group(item, columns))
            continue
        real = match_column(item.column, columns)
        if real is None:
            suggestions = suggest_columns(item.column, columns)
            hint = f" Did you mean: {', '.join(suggestions)}?" if suggestions else ""
            raise ValueError(
                f"Unknown column '{item.column}'. Available columns: {', '.join(columns)}.{hint}"
            )
        resolved.append(FilterCondition(column=real, op=item.op, value=item.value))
    return FilterGroup(logic=group.logic, conditions=resolved)


def _apply_group(
    df: pd.DataFrame, group: FilterGroup, *, path: str
) -> tuple[pd.Series, list[dict[str, Any]]]:
    if not group.conditions:
        return pd.Series(True, index=df.index), []

    if group.logic == "or":
        mask = pd.Series(False, index=df.index)
        trace: list[dict[str, Any]] = []
        for i, item in enumerate(group.conditions):
            child_mask, child_trace = _apply_item(df, item, path=f"{path}.or[{i}]")
            before = int(mask.sum())
            mask = mask | child_mask
            after = int(mask.sum())
            trace.append(
                {
                    "path": f"{path}.or[{i}]",
                    "logic": "or",
                    "added_rows": after - before,
                    "rows_after_union": after,
                    "child": child_trace,
                    "predicate": _describe(item),
                }
            )
        return mask, trace

    # AND — apply high-selectivity (narrowing) predicates first.
    ordered = order_and_children(df, group.conditions)
    mask = pd.Series(True, index=df.index)
    working = df
    trace = []
    for i, item in enumerate(ordered):
        child_mask, child_trace = _apply_item(working, item, path=f"{path}.and[{i}]")
        # child_mask is aligned to `working`; expand to original index via loc.
        aligned = pd.Series(False, index=df.index)
        aligned.loc[working.index] = child_mask.values
        before = int(mask.sum())
        mask = mask & aligned
        after = int(mask.sum())
        working = df.loc[mask]
        pred = _describe(item)
        killed = before > 0 and after == 0
        trace.append(
            {
                "path": f"{path}.and[{i}]",
                "logic": "and",
                "order": i + 1,
                "predicate": pred,
                "estimated_selectivity": estimate_selectivity(df, item),
                "rows_before": before,
                "rows_after": after,
                "dropped": before - after,
                "emptied_result": killed,
                "note": (
                    "This predicate removed every remaining row. "
                    "Combining it with AND hid the rest of the data. "
                    "Consider relaxing it or switching same-column values to OR."
                    if killed
                    else "Applied after more selective predicates so remaining rows stay visible."
                ),
                "child": child_trace,
            }
        )
    return mask, trace


def _apply_item(
    df: pd.DataFrame, item: FilterCondition | FilterGroup, *, path: str
) -> tuple[pd.Series, list[dict[str, Any]]]:
    if isinstance(item, FilterGroup):
        return _apply_group(df, item, path=path)
    return _apply_condition(df, item), []


def _apply_condition(df: pd.DataFrame, cond: FilterCondition) -> pd.Series:
    if cond.column not in df.columns:
        raise ValueError(f"Column '{cond.column}' is not in the frame.")
    series = df[cond.column]
    op = cond.op
    value = cond.value

    if op == "is_null":
        return series.isna()
    if op == "not_null":
        return series.notna()

    if op in {"year_eq", "year_between", "date_before", "date_after"}:
        dates = _as_datetime(series)
        if op == "year_eq":
            year = int(value if not isinstance(value, list) else value[0])
            return dates.dt.year == year
        if op == "year_between":
            lo, hi = _pair(value)
            years = dates.dt.year
            return (years >= int(lo)) & (years <= int(hi))
        if op == "date_before":
            return dates < pd.to_datetime(value, format="mixed")
        return dates > pd.to_datetime(value, format="mixed")

    coerced = coerce_value(series, value)

    if op == "eq":
        return _eq(series, coerced)
    if op == "ne":
        return ~_eq(series, coerced)
    if op == "gt":
        return _numeric(series) > coerced
    if op == "gte":
        return _numeric(series) >= coerced
    if op == "lt":
        return _numeric(series) < coerced
    if op == "lte":
        return _numeric(series) <= coerced
    if op == "between":
        lo, hi = _pair(coerced if isinstance(coerced, list) else value)
        lo_c, hi_c = coerce_value(series, lo), coerce_value(series, hi)
        num = _numeric(series) if pd.api.types.is_numeric_dtype(series) else _as_datetime(series)
        return (num >= lo_c) & (num <= hi_c)
    if op == "in":
        values = coerced if isinstance(coerced, list) else [coerced]
        return _isin(series, values)
    if op == "not_in":
        values = coerced if isinstance(coerced, list) else [coerced]
        return ~_isin(series, values)
    if op == "contains":
        return _as_str(series).str.contains(str(value), case=False, na=False, regex=False)
    if op == "not_contains":
        return ~_as_str(series).str.contains(str(value), case=False, na=False, regex=False)
    if op == "starts_with":
        return _as_str(series).str.startswith(str(value), na=False)
    if op == "ends_with":
        return _as_str(series).str.endswith(str(value), na=False)
    if op == "regex":
        return _as_str(series).str.contains(str(value), case=False, na=False, regex=True)
    raise ValueError(f"Unsupported operator '{op}'")


def _eq(series: pd.Series, value: Any) -> pd.Series:
    if pd.api.types.is_string_dtype(series) or series.dtype == object:
        return _as_str(series).str.casefold() == str(value).casefold()
    if pd.api.types.is_bool_dtype(series):
        return series == bool(value)
    return series == value


def _isin(series: pd.Series, values: list[Any]) -> pd.Series:
    if pd.api.types.is_string_dtype(series) or series.dtype == object:
        folded = {str(v).casefold() for v in values}
        return _as_str(series).str.casefold().isin(folded)
    return series.isin(values)


def _as_str(series: pd.Series) -> pd.Series:
    return series.astype("string")


def _numeric(series: pd.Series) -> pd.Series:
    if pd.api.types.is_numeric_dtype(series):
        return series
    return pd.to_numeric(
        series.astype(str).str.replace(r"[,$]", "", regex=True),
        errors="coerce",
    )


def _as_datetime(series: pd.Series) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(series):
        return series
    return pd.to_datetime(series, errors="coerce", format="mixed")


def _pair(value: Any) -> tuple[Any, Any]:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return value[0], value[1]
    raise ValueError("between / year_between require a two-element [min, max] value.")


def _describe(item: FilterCondition | FilterGroup) -> dict[str, Any]:
    if isinstance(item, FilterGroup):
        return item.to_dict()
    return item.to_dict()


def human_summary(result: dict[str, Any]) -> str:
    n_in = result["n_input"]
    n_out = result["n_matched"]
    pct = (100.0 * n_out / n_in) if n_in else 0.0
    bits = [f"Matched {n_out:,} of {n_in:,} rows ({pct:.1f}%)."]
    if result.get("empty"):
        bits.append("The result is empty — see the filter trace for which predicate removed the last rows.")
    # Highlight the most destructive AND step.
    def walk(nodes: list[dict[str, Any]]) -> None:
        for node in nodes:
            if node.get("logic") == "and" and node.get("dropped", 0) > 0:
                pred = node.get("predicate") or {}
                bits.append(
                    f"AND step {node.get('order')}: {pred.get('column')} {pred.get('op')} "
                    f"{pred.get('value')} dropped {node['dropped']:,} rows "
                    f"({node['rows_before']:,} → {node['rows_after']:,})."
                )
            child = node.get("child") or []
            if child:
                walk(child)

    walk(result.get("trace") or [])
    return " ".join(bits)


def preview_dict(result: dict[str, Any], *, head: int = 5) -> dict[str, Any]:
    frame: pd.DataFrame = result["frame"]
    payload = {k: v for k, v in result.items() if k != "frame"}
    payload["summary"] = human_summary(result)
    payload["columns"] = [str(c) for c in frame.columns]
    payload["sample_rows"] = json_safe(frame.head(head).to_dict(orient="records"))
    return json_safe(payload)
