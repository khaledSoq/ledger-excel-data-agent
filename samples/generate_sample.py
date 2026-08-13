"""Generate samples/employees.xlsx — a realistic sheet for demos and tests."""

from __future__ import annotations

import random
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
DEPTS = ["Sales", "Engineering", "Marketing", "Finance", "Operations", "Support"]
STATUSES = ["Active", "Active", "Active", "Active", "On Leave", "Inactive"]
REGIONS = ["East", "West", "Central", "North", "South"]
CITIES = {
    "East": ["Boston", "New York", "Philadelphia"],
    "West": ["Seattle", "San Francisco", "Portland"],
    "Central": ["Chicago", "Dallas", "Denver"],
    "North": ["Minneapolis", "Detroit"],
    "South": ["Austin", "Atlanta", "Miami"],
}
ROLES = {
    "Sales": ["Account Exec", "SDR", "Sales Manager"],
    "Engineering": ["Software Engineer", "Data Engineer", "Staff Engineer"],
    "Marketing": ["Content Lead", "Growth Marketer", "Designer"],
    "Finance": ["Analyst", "Controller", "FP&A"],
    "Operations": ["Ops Coordinator", "Program Manager"],
    "Support": ["Support Specialist", "Success Manager"],
}


def build(n: int = 80, seed: int = 7) -> pd.DataFrame:
    rng = random.Random(seed)
    rows = []
    start = date(2020, 1, 15)
    for i in range(1, n + 1):
        dept = rng.choice(DEPTS)
        region = rng.choice(REGIONS)
        hired = start + timedelta(days=rng.randint(0, 2000))
        age = rng.randint(22, 58)
        # Inject a few anomalies: extreme salary, impossible age, rare status.
        salary = int(rng.gauss(92000, 18000))
        salary = max(48000, min(salary, 175000))
        perf = round(min(5.0, max(1.0, rng.gauss(3.6, 0.7))), 1)
        status = rng.choice(STATUSES)
        rows.append(
            {
                "EmployeeID": f"E{i:04d}",
                "Name": f"Person {i}",
                "Age": age,
                "Department": dept,
                "Role": rng.choice(ROLES[dept]),
                "Status": status,
                "Region": region,
                "City": rng.choice(CITIES[region]),
                "HireDate": hired.isoformat(),
                "Salary": salary,
                "Performance": perf,
                "Headcount": rng.choice([0, 0, 0, 1, 1, 2, 3]),
            }
        )
    # Controlled anomalies the agent should surface.
    rows[0]["Salary"] = 480000  # extreme compensation
    rows[1]["Age"] = 82  # age outlier
    rows[2]["Status"] = "Contractor"  # rare category
    rows[3]["Performance"] = 0.2  # performance floor
    return pd.DataFrame(rows)


def main() -> Path:
    ROOT.mkdir(parents=True, exist_ok=True)
    df = build()
    xlsx = ROOT / "employees.xlsx"
    csv = ROOT / "employees.csv"
    df.to_excel(xlsx, index=False)
    df.to_csv(csv, index=False)
    print(f"Wrote {xlsx} and {csv} ({len(df)} rows)")
    return xlsx


if __name__ == "__main__":
    main()
