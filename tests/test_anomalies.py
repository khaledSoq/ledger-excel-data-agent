from __future__ import annotations

from excel_data_agent.core.anomalies import analyze_anomalies


def test_salary_outlier_flagged(employees) -> None:
    report = analyze_anomalies(employees, columns=["Salary"])
    col = report["columns"][0]
    assert col["n_flagged"] >= 1
    values = [r["value"] for r in col["records"]]
    assert 480000 in values
    assert "formulas" in report
    assert "iqr" in report["formulas"]


def test_rare_status_flagged(employees) -> None:
    report = analyze_anomalies(employees, columns=["Status"])
    col = report["columns"][0]
    labels = {r["value"] for r in col["records"]}
    assert "Contractor" in labels
