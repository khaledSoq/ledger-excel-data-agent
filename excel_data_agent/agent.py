"""ADK root agent — discovered by `adk web` as `excel_data_agent`.

Default backend is a local Ollama model via LiteLLM. Switch with env vars
(see `excel_data_agent.config.ModelConfig`).
"""

from __future__ import annotations

import logging
from typing import Any

from excel_data_agent.config import (
    apply_ollama_env,
    ensure_directories,
    get_model_config,
)
from excel_data_agent.prompts import AGENT_DESCRIPTION, SYSTEM_INSTRUCTION
from excel_data_agent.tools import ALL_TOOLS

logger = logging.getLogger(__name__)


def _build_model() -> Any:
    cfg = get_model_config()
    apply_ollama_env(cfg)

    if cfg.provider == "gemini":
        # Native ADK Gemini string — no LiteLLM required.
        model_id = cfg.resolved_model_id()
        logger.info("Using native Gemini model: %s", model_id)
        return model_id

    try:
        from google.adk.models.lite_llm import LiteLlm
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "google-adk with LiteLLM is required for local / provider models. "
            "Install: pip install 'google-adk' 'litellm>=1.84'"
        ) from exc

    if cfg.debug_litellm:
        try:
            import litellm

            litellm._turn_on_debug()  # noqa: SLF001
        except Exception:  # noqa: BLE001
            logger.warning("Could not enable LiteLLM debug logging.")

    # Prefer ollama_chat/ over ollama/ — the chat API is the one that
    # reliably supports tool calling and does not ignore conversation context.
    model_id = cfg.model
    if cfg.provider == "ollama" and model_id.startswith("ollama/"):
        model_id = "ollama_chat/" + model_id.split("/", 1)[1]
        logger.info("Rewrote model id to tool-calling chat API: %s", model_id)

    kwargs: dict[str, Any] = {
        "model": model_id,
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
        "top_p": cfg.top_p,
        "timeout": cfg.timeout,
    }
    if cfg.provider == "ollama" or model_id.startswith("ollama"):
        kwargs["api_base"] = cfg.ollama_api_base
        # Ollama runtime options (context window matters for inspect payloads).
        kwargs["extra_body"] = {
            "options": {
                "num_ctx": cfg.num_ctx,
                "temperature": cfg.temperature,
                "top_p": cfg.top_p,
            }
        }

    logger.info(
        "Using LiteLLM model=%s api_base=%s temp=%s ctx=%s",
        model_id,
        kwargs.get("api_base"),
        cfg.temperature,
        cfg.num_ctx,
    )
    return LiteLlm(**kwargs)


def build_root_agent() -> Any:
    """Construct the LlmAgent. Called at import so `adk web` finds `root_agent`."""
    ensure_directories()

    try:
        from google.adk.agents import LlmAgent
    except ImportError:  # pragma: no cover
        try:
            from google.adk.agents.llm_agent import LlmAgent
        except ImportError as exc:
            raise RuntimeError(
                "google-adk is not installed. Run: pip install -r requirements.txt"
            ) from exc

    # Wrap tools as FunctionTool when the class is available (ADK 1.x / 2.x).
    tools: list[Any] = list(ALL_TOOLS)
    try:
        from google.adk.tools import FunctionTool

        tools = [FunctionTool(func=fn) for fn in ALL_TOOLS]
    except Exception:  # noqa: BLE001
        # Bare callables are auto-wrapped by LlmAgent.
        pass

    return LlmAgent(
        name="excel_data_agent",
        model=_build_model(),
        description=AGENT_DESCRIPTION,
        instruction=SYSTEM_INSTRUCTION,
        tools=tools,
    )


# `adk web` loads this symbol from excel_data_agent/agent.py
root_agent = build_root_agent()
