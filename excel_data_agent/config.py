"""Runtime configuration for the Excel Data Agent.

Model selection is environment-driven so the same agent can run fully local
(Ollama + LiteLLM) or optionally against Gemini / any LiteLLM provider.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    return default if value is None or value.strip() == "" else value.strip()


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# Default upload / output directories (created on first use).
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(_env("EXCEL_AGENT_DATA_DIR", str(WORKSPACE_ROOT / "data")))
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
SAMPLES_DIR = WORKSPACE_ROOT / "samples"

MAX_FILE_BYTES = _env_int("EXCEL_AGENT_MAX_FILE_BYTES", 50 * 1024 * 1024)
MAX_ROWS = _env_int("EXCEL_AGENT_MAX_ROWS", 500_000)
SAMPLE_HEAD = _env_int("EXCEL_AGENT_SAMPLE_HEAD", 5)
CATEGORICAL_UNIQUE_CAP = _env_int("EXCEL_AGENT_CATEGORICAL_UNIQUE_CAP", 40)
CATEGORICAL_RATIO = _env_float("EXCEL_AGENT_CATEGORICAL_RATIO", 0.08)


@dataclass(frozen=True)
class ModelConfig:
    """Switchable LLM backend.

    Local (default)
    ---------------
    ADK_MODEL_PROVIDER=ollama
    ADK_MODEL=ollama_chat/llama3.2:3b
    OLLAMA_API_BASE=http://localhost:11434

    Gemini (optional cloud)
    -----------------------
    ADK_MODEL_PROVIDER=gemini
    ADK_MODEL=gemini-2.0-flash
    GOOGLE_API_KEY=...

    Any other LiteLLM provider
    --------------------------
    ADK_MODEL_PROVIDER=litellm
    ADK_MODEL=openai/gpt-4o-mini
    OPENAI_API_KEY=...
    """

    provider: str = field(default_factory=lambda: _env("ADK_MODEL_PROVIDER", "ollama").lower())
    model: str = field(
        default_factory=lambda: _env("ADK_MODEL", "ollama_chat/llama3.2:3b")
    )
    ollama_api_base: str = field(
        default_factory=lambda: _env("OLLAMA_API_BASE", "http://localhost:11434")
    )
    gemini_model: str = field(
        default_factory=lambda: _env("GEMINI_MODEL", "gemini-2.0-flash")
    )
    temperature: float = field(default_factory=lambda: _env_float("ADK_TEMPERATURE", 0.1))
    max_tokens: int = field(default_factory=lambda: _env_int("ADK_MAX_TOKENS", 2048))
    top_p: float = field(default_factory=lambda: _env_float("ADK_TOP_P", 0.9))
    num_ctx: int = field(default_factory=lambda: _env_int("ADK_NUM_CTX", 8192))
    timeout: int = field(default_factory=lambda: _env_int("ADK_TIMEOUT", 180))
    debug_litellm: bool = field(default_factory=lambda: _env_bool("ADK_LITELLM_DEBUG", False))

    def resolved_model_id(self) -> str:
        if self.provider == "gemini":
            return self.gemini_model if self.model.startswith("ollama") else self.model
        return self.model


def get_model_config() -> ModelConfig:
    return ModelConfig()


def ensure_directories() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)


def apply_ollama_env(cfg: ModelConfig | None = None) -> None:
    """Force Ollama to the configured local base URL before LiteLLM is imported."""
    cfg = cfg or get_model_config()
    os.environ.setdefault("OLLAMA_API_BASE", cfg.ollama_api_base)
    # LiteLLM also honors this alias.
    os.environ.setdefault("OLLAMA_HOST", cfg.ollama_api_base)
