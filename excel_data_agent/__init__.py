"""Excel Data Agent — local-first Google ADK agent for Excel filtering and analysis."""

from __future__ import annotations

from typing import Any

__all__ = ["root_agent", "build_root_agent"]
__version__ = "1.0.0"


def build_root_agent() -> Any:
    from excel_data_agent.agent import build_root_agent as _build

    return _build()


def __getattr__(name: str) -> Any:
    if name == "root_agent":
        from excel_data_agent.agent import root_agent as _root

        return _root
    raise AttributeError(name)
