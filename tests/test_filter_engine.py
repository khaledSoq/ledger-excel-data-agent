from __future__ import annotations

import json

import pandas as pd

from excel_data_agent.core.filter_engine import apply_plan


def test_age_between_and_department(employees: pd.DataFrame) -> None:
    plan = {
        "logic": "and",
        "conditions": [
            {"column": "Age", "op": "between", "value": [25, 40]},
            {"column": "Department", "op": "eq", "value": "Sales"},
        ],
    }
    result = apply_plan(employees, json.dumps(plan))
    frame: pd.DataFrame = result["frame"]
    assert result["n_matched"] == len(frame)
    assert set(frame["Department"].unique()) <= {"Sales"}
    assert frame["Age"].between(25, 40).all()
    # AND children are ordered by selectivity — Department (eq) before Age (between).
    first = result["trace"][0]["predicate"]
    assert first["column"] == "Department"


def test_same_column_and_is_empty(employees: pd.DataFrame) -> None:
    plan = {
        "logic": "and",
        "conditions": [
            {"column": "Department", "op": "eq", "value": "Sales"},
            {"column": "Department", "op": "eq", "value": "Marketing"},
        ],
    }
    result = apply_plan(employees, plan)
    assert result["empty"] is True
    assert any(step.get("emptied_result") for step in result["trace"])


def test_in_is_or_for_same_column(employees: pd.DataFrame) -> None:
    plan = {
        "logic": "and",
        "conditions": [
            {"column": "Department", "op": "in", "value": ["Sales", "Marketing"]},
            {"column": "Status", "op": "eq", "value": "Active"},
        ],
    }
    result = apply_plan(employees, plan)
    frame = result["frame"]
    assert set(frame["Department"]).issubset({"Sales", "Marketing"})
    assert (frame["Status"] == "Active").all()
    assert result["n_matched"] > 0


def test_year_eq_on_hire_date(employees: pd.DataFrame) -> None:
    result = apply_plan(
        employees,
        {"column": "HireDate", "op": "year_eq", "value": 2024},
    )
    years = pd.to_datetime(result["frame"]["HireDate"]).dt.year
    assert (years == 2024).all()


def test_unknown_column_raises(employees: pd.DataFrame) -> None:
    try:
        apply_plan(employees, {"column": "Nope", "op": "eq", "value": 1})
    except ValueError as exc:
        assert "Unknown column" in str(exc)
        return
    raise AssertionError("expected ValueError")


def test_case_insensitive_column_and_value(employees: pd.DataFrame) -> None:
    result = apply_plan(
        employees,
        {"column": "department", "op": "eq", "value": "sales"},
    )
    assert (result["frame"]["Department"] == "Sales").all()
    assert result["n_matched"] > 0
