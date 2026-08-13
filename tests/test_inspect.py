from __future__ import annotations

from excel_data_agent.core.inspect_engine import inspect_frame
from excel_data_agent.tools.inspect import inspect_excel


def test_inspect_reports_columns_and_strategy(employees) -> None:
    report = inspect_frame(employees, file_path="mem")
    names = report["column_names"]
    assert "Age" in names and "Department" in names
    kinds = {c["name"]: c["kind"] for c in report["columns"]}
    assert kinds["Department"] == "categorical"
    assert kinds["Age"] in {"numeric_continuous", "numeric_discrete"}
    assert "recommended_filter_order" in report["filter_strategy"]
    assert report["n_rows"] == len(employees)


def test_inspect_excel_tool_reads_file(employees_path) -> None:
    report = inspect_excel(str(employees_path))
    assert report["status"] == "success"
    assert report["n_cols"] >= 8
