from __future__ import annotations

import numpy as np
import pandas as pd

from excel_data_agent.core.distributions import fit_column


def test_normal_recommendation() -> None:
    rng = np.random.default_rng(0)
    s = pd.Series(rng.normal(50, 5, 200))
    report = fit_column(s, name="x")
    assert report["recommended"] == "normal"


def test_poisson_recommendation() -> None:
    rng = np.random.default_rng(1)
    s = pd.Series(rng.poisson(4, 250))
    report = fit_column(s, name="counts")
    assert report["recommended"] == "poisson"


def test_lognormal_or_gamma_for_skewed_positive() -> None:
    rng = np.random.default_rng(2)
    s = pd.Series(rng.lognormal(mean=10.5, sigma=0.4, size=200))
    report = fit_column(s, name="salary")
    assert report["recommended"] in {"lognormal", "gamma", "exponential"}
