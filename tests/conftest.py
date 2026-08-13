from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from samples.generate_sample import build  # noqa: E402


@pytest.fixture
def employees() -> pd.DataFrame:
    return build()


@pytest.fixture
def employees_path(tmp_path: Path, employees: pd.DataFrame) -> Path:
    path = tmp_path / "employees.xlsx"
    employees.to_excel(path, index=False)
    return path
