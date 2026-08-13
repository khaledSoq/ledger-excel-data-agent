"""Helpers for optional ADK ToolContext (keeps tools usable outside ADK)."""

from __future__ import annotations

from typing import Any


def state_get(tool_context: Any, key: str, default: Any = None) -> Any:
    if tool_context is None:
        return default
    state = getattr(tool_context, "state", None)
    if state is None:
        return default
    try:
        return state.get(key, default)
    except Exception:  # noqa: BLE001
        return default


def state_set(tool_context: Any, key: str, value: Any) -> None:
    if tool_context is None:
        return
    state = getattr(tool_context, "state", None)
    if state is None:
        return
    try:
        state[key] = value
    except Exception:  # noqa: BLE001
        try:
            state.set(key, value)
        except Exception:  # noqa: BLE001
            return


def resolve_file_path(file_path: str, tool_context: Any) -> str:
    path = (file_path or "").strip()
    if path:
        return path
    stored = state_get(tool_context, "current_file", "")
    if stored:
        return str(stored)
    return ""


def error_dict(exc: BaseException) -> dict[str, Any]:
    code = getattr(exc, "code", "error")
    return {
        "status": "error",
        "error_code": code,
        "error_message": str(exc),
    }
