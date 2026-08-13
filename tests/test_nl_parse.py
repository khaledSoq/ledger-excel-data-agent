from __future__ import annotations

from excel_data_agent.core.filter_engine import apply_plan
from excel_data_agent.core.inspect_engine import inspect_frame
from excel_data_agent.core.nl_parse import parse_natural_language


def _conds(plan: dict) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for c in plan["conditions"]:
        vals = c["value"] if isinstance(c["value"], list) else [c["value"]]
        out[c["column"]] = [str(v) for v in vals]
        assert c["op"] in {"eq", "in"}
    return out


def test_inactive_or_on_leave_from_finance_or_hr(employees) -> None:
    inspect = inspect_frame(employees)
    parsed = parse_natural_language(
        "All Inactive or On Leave employees from Finance or HR",
        inspect,
    )
    assert parsed["ok"] is True
    groups = _conds(parsed["plan"])
    assert set(groups["Status"]) == {"Inactive", "On Leave"}
    # HR is in the generator; Finance always is.
    assert "Finance" in groups["Department"]
    assert parsed["plan"]["logic"] == "and"
    # Must NOT be a flat OR of mixed columns.
    assert parsed["plan"]["logic"] != "or"

    result = apply_plan(employees, parsed["plan"])
    frame = result["frame"]
    assert set(frame["Status"]).issubset({"Inactive", "On Leave"})
    assert set(frame["Department"]).issubset(set(groups["Department"]))
    # Flattened OR would include every Finance/HR Active row — those must be excluded.
    assert not ((frame["Department"].isin(groups["Department"])) & (frame["Status"] == "Active")).any()


def test_active_or_on_leave_in_sales_or_marketing(employees) -> None:
    inspect = inspect_frame(employees)
    parsed = parse_natural_language(
        "Active or On Leave people in Sales or Marketing",
        inspect,
    )
    assert parsed["ok"] is True
    groups = _conds(parsed["plan"])
    assert set(groups["Status"]) == {"Active", "On Leave"}
    assert set(groups["Department"]) == {"Sales", "Marketing"}
    result = apply_plan(employees, parsed["plan"])
    frame = result["frame"]
    assert set(frame["Status"]).issubset({"Active", "On Leave"})
    assert set(frame["Department"]).issubset({"Sales", "Marketing"})


def test_inactive_from_engineering_is_simple_and(employees) -> None:
    inspect = inspect_frame(employees)
    parsed = parse_natural_language(
        "Employees who are Inactive from Engineering",
        inspect,
    )
    assert parsed["ok"] is True
    groups = _conds(parsed["plan"])
    assert groups["Status"] == ["Inactive"]
    assert groups["Department"] == ["Engineering"]
    result = apply_plan(employees, parsed["plan"])
    frame = result["frame"]
    if len(frame):
        assert (frame["Status"] == "Inactive").all()
        assert (frame["Department"] == "Engineering").all()
