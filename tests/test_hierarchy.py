from __future__ import annotations

from excel_data_agent.core.hierarchy import estimate_selectivity, order_and_children
from excel_data_agent.core.types import FilterCondition


def test_equality_more_selective_than_range(employees) -> None:
    eq = FilterCondition(column="Department", op="eq", value="Sales")
    rng = FilterCondition(column="Age", op="between", value=[25, 40])
    assert estimate_selectivity(employees, eq) < estimate_selectivity(employees, rng)
    ordered = order_and_children(employees, [rng, eq])
    assert ordered[0] is eq
