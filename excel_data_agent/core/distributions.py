"""Choose a plausible distribution for a numeric column.

Decision rules (applied in order, documented so the agent can explain them)
---------------------------------------------------------------------------
Let x be the non-missing numeric sample, n = |x|,
    x̄ = mean, s² = variance, CV = s / x̄  (x̄ > 0),
    γ₁ = sample skewness, γ₂ = excess kurtosis.

A. Discrete / counts (values are integers, ≥ 0, n_unique small or CV near 1)
   - If x̄ ≈ s² (ratio in [0.7, 1.3]) → Poisson
        P(K = k) = e^{-λ} λ^k / k!    with λ̂ = x̄
   - Else if many zeros and variance >> mean → over-dispersed counts (neg-bin hint)

B. Bounded-looking / flat
   - If |γ₁| < 0.3 and the histogram is not peaked (excess kurtosis < −0.8)
     → Uniform on [min, max]
        f(x) = 1 / (b − a)

C. Positive support + right skew (γ₁ > 0.5, min ≥ 0)
   - If CV ≈ 1 (±0.25) and mass near 0 → Exponential
        f(x) = λ e^{−λx}    λ̂ = 1 / x̄
   - If log(x) (x>0) looks closer to normal than x
     (compare |skew(log x)| vs |skew(x)|) → Lognormal
        ln X ~ N(μ, σ²)
   - Else → Gamma (shape-scale), the flexible positive right-skew family
        f(x) = 1/(Γ(k) θ^k) x^{k−1} e^{−x/θ}

D. Symmetric-ish real-valued
   - |γ₁| < 0.5 and |γ₂| < 1 → Normal
        f(x) = (1 / (σ√(2π))) exp(−(x−μ)² / (2σ²))

E. Fallback
   - Empirical / unspecified. Report quantiles; do not force a parametric family.

Goodness-of-fit (descriptive, not a formal test battery)
--------------------------------------------------------
- Shapiro–Wilk on x (and on log x) when 8 ≤ n ≤ 2000 — W close to 1, p > 0.05
  supports normality.
- Coefficient of variation and mean/variance ratio as moment checks.
We deliberately avoid claiming a distribution is *true*; we recommend the
best working model for summarising / simulating the column.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from excel_data_agent.core.column_semantics import infer_kind, match_column
from excel_data_agent.core.types import json_safe

FAMILIES = {
    "normal": {
        "name": "Normal (Gaussian)",
        "pdf": "f(x) = 1/(σ√(2π)) · exp(−(x−μ)² / (2σ²))",
        "params": "μ = mean, σ = std",
        "use_when": "Symmetric continuous data, |skew| < 0.5, excess kurtosis near 0.",
    },
    "lognormal": {
        "name": "Log-normal",
        "pdf": "X > 0,  ln X ~ N(μ, σ²)",
        "params": "μ = mean(ln x), σ = std(ln x)",
        "use_when": "Positive, right-skewed amounts (salary, price, time-to-event).",
    },
    "exponential": {
        "name": "Exponential",
        "pdf": "f(x) = λ e^{−λx}   (x ≥ 0)",
        "params": "λ̂ = 1 / mean",
        "use_when": "Positive, CV ≈ 1, memoryless waiting times.",
    },
    "gamma": {
        "name": "Gamma",
        "pdf": "f(x) = 1/(Γ(k) θ^k) x^{k−1} e^{−x/θ}",
        "params": "k̂ = (mean/std)²,  θ̂ = variance/mean   (method of moments)",
        "use_when": "Positive, right-skewed, more flexible than exponential.",
    },
    "poisson": {
        "name": "Poisson",
        "pmf": "P(K=k) = e^{−λ} λ^k / k!",
        "params": "λ̂ = mean",
        "use_when": "Non-negative integer counts with variance ≈ mean.",
    },
    "uniform": {
        "name": "Uniform",
        "pdf": "f(x) = 1 / (b − a)  on [a, b]",
        "params": "a = min, b = max",
        "use_when": "Flat histogram, low |skew|, negative excess kurtosis.",
    },
    "empirical": {
        "name": "Empirical (no parametric family)",
        "pdf": "Use the sample quantiles / ECDF.",
        "params": "Q1, median, Q3, min, max",
        "use_when": "Mixed, multimodal, or too little data to justify a family.",
    },
}


def analyze_distributions(
    df: pd.DataFrame, *, columns: list[str] | None = None
) -> dict[str, Any]:
    names = columns or [
        str(c)
        for c in df.columns
        if infer_kind(str(c), df[c]) in {"numeric_continuous", "numeric_discrete"}
        or pd.api.types.is_numeric_dtype(df[c])
    ]
    reports = []
    for raw in names:
        real = match_column(raw, [str(c) for c in df.columns])
        if real is None:
            reports.append({"column": raw, "status": "error", "error": "Unknown column."})
            continue
        reports.append(fit_column(df[real], name=real))
    return json_safe(
        {
            "status": "success",
            "families": FAMILIES,
            "selection_rules": (
                "counts + var≈mean → Poisson; flat + platykurtic → Uniform; "
                "positive + CV≈1 → Exponential; positive + log closer to normal → Lognormal; "
                "positive skew otherwise → Gamma; |skew|<0.5 → Normal; else Empirical."
            ),
            "columns": reports,
        }
    )


def fit_column(series: pd.Series, *, name: str) -> dict[str, Any]:
    num = pd.to_numeric(series, errors="coerce").dropna()
    values = num.to_numpy(dtype=float)
    n = values.size
    if n < 5:
        return {
            "column": name,
            "status": "skipped",
            "reason": "Need at least 5 numeric values.",
            "recommended": "empirical",
        }
    mean = float(values.mean())
    std = float(values.std(ddof=1)) if n > 1 else 0.0
    var = float(values.var(ddof=1)) if n > 1 else 0.0
    med = float(np.median(values))
    skew = float(pd.Series(values).skew())
    kurt = float(pd.Series(values).kurtosis())
    vmin, vmax = float(values.min()), float(values.max())
    cv = (std / mean) if mean not in (0.0, -0.0) else None
    integerish = bool(np.allclose(values, np.round(values), atol=1e-8))
    nonneg = bool(vmin >= 0)
    positive = values[values > 0]

    shapiro_x = _shapiro(values)
    shapiro_log = _shapiro(np.log(positive)) if positive.size >= 8 else None

    recommended, why = _choose(
        n=n,
        mean=mean,
        var=var,
        cv=cv,
        skew=skew,
        kurt=kurt,
        integerish=integerish,
        nonneg=nonneg,
        shapiro_x=shapiro_x,
        shapiro_log=shapiro_log,
        n_positive=int(positive.size),
    )
    params = _params(recommended, values, mean, std, var, vmin, vmax)
    return {
        "column": name,
        "n": n,
        "moments": {
            "mean": mean,
            "std": std,
            "variance": var,
            "median": med,
            "skewness": skew,
            "excess_kurtosis": kurt,
            "cv": cv,
            "min": vmin,
            "max": vmax,
            "integerish": integerish,
            "non_negative": nonneg,
        },
        "goodness_of_fit": {
            "shapiro_wilk_x": shapiro_x,
            "shapiro_wilk_log_x": shapiro_log,
        },
        "recommended": recommended,
        "why": why,
        "family": FAMILIES[recommended],
        "fitted_params": params,
    }


def _choose(
    *,
    n: int,
    mean: float,
    var: float,
    cv: float | None,
    skew: float,
    kurt: float,
    integerish: bool,
    nonneg: bool,
    shapiro_x: dict[str, Any] | None,
    shapiro_log: dict[str, Any] | None,
    n_positive: int,
) -> tuple[str, str]:
    if n < 8:
        return "empirical", "n < 8 — too small for a parametric claim. Report quantiles only."

    if integerish and nonneg and mean > 0:
        ratio = var / mean if mean else None
        if ratio is not None and 0.7 <= ratio <= 1.3:
            return (
                "poisson",
                f"Non-negative integers with variance/mean = {ratio:.2f} ≈ 1 (Poisson moment condition).",
            )

    if abs(skew) < 0.3 and kurt < -0.8:
        return "uniform", "Low skew and negative excess kurtosis — histogram looks flatter than a Gaussian."

    if nonneg and n_positive >= 8 and skew > 0.5:
        if cv is not None and abs(cv - 1.0) <= 0.25 and skew > 0.8:
            return (
                "exponential",
                f"Positive, right-skewed, CV={cv:.2f} ≈ 1 — exponential moment condition.",
            )
        log_better = False
        if shapiro_log and shapiro_x:
            log_better = (shapiro_log.get("W") or 0) > (shapiro_x.get("W") or 0)
        elif shapiro_log:
            log_better = True
        if log_better:
            return (
                "lognormal",
                "Positive and right-skewed; ln(x) is closer to normal than x (salary / size pattern).",
            )
        return "gamma", "Positive and right-skewed; gamma is the flexible default over exponential."

    if abs(skew) < 0.5 and abs(kurt) < 1.0:
        extra = ""
        if shapiro_x and shapiro_x.get("p") is not None:
            extra = f" Shapiro–Wilk p={shapiro_x['p']:.3f}."
        return "normal", f"|skew|={abs(skew):.2f}, |excess kurtosis|={abs(kurt):.2f}.{extra}"

    return "empirical", "Shape is mixed or heavy-tailed; keep the empirical distribution."


def _params(
    family: str,
    values: np.ndarray,
    mean: float,
    std: float,
    var: float,
    vmin: float,
    vmax: float,
) -> dict[str, Any]:
    if family == "normal":
        return {"mu": mean, "sigma": std}
    if family == "lognormal":
        pos = values[values > 0]
        logs = np.log(pos) if pos.size else np.array([0.0])
        return {"mu_log": float(logs.mean()), "sigma_log": float(logs.std(ddof=1)) if logs.size > 1 else 0.0}
    if family == "exponential":
        return {"lambda": (1.0 / mean) if mean > 0 else None}
    if family == "gamma":
        k = (mean / std) ** 2 if std > 0 else None
        theta = (var / mean) if mean else None
        return {"shape_k": k, "scale_theta": theta}
    if family == "poisson":
        return {"lambda": mean}
    if family == "uniform":
        return {"a": vmin, "b": vmax}
    q = np.quantile(values, [0.05, 0.25, 0.5, 0.75, 0.95])
    return {"q05": float(q[0]), "q25": float(q[1]), "q50": float(q[2]), "q75": float(q[3]), "q95": float(q[4])}


def _shapiro(values: np.ndarray) -> dict[str, Any] | None:
    n = values.size
    if n < 8 or n > 2000:
        return None
    try:
        from scipy.stats import shapiro

        # Shapiro is expensive / over-sensitive at large n; we already cap at 2000.
        sample = values if n <= 500 else np.random.default_rng(0).choice(values, 500, replace=False)
        W, p = shapiro(sample)
        return {"W": float(W), "p": float(p), "n_tested": int(sample.size)}
    except Exception:  # noqa: BLE001
        return None
