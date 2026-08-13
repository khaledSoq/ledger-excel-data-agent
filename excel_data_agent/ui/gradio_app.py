"""Optional Gradio wrapper.

    python -m excel_data_agent.ui.gradio_app
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import gradio as gr  # noqa: E402

from excel_data_agent.config import UPLOAD_DIR, ensure_directories, get_model_config  # noqa: E402
from excel_data_agent.core.excel_io import read_tabular, write_csv  # noqa: E402
from excel_data_agent.core.filter_engine import apply_plan, preview_dict  # noqa: E402
from excel_data_agent.core.inspect_engine import inspect_frame  # noqa: E402


def _handle(file_obj, plan_json: str):
    if file_obj is None:
        return "Please upload your Excel file, then describe the data you need.", None, None
    ensure_directories()
    src = Path(file_obj.name)
    dest = UPLOAD_DIR / src.name
    dest.write_bytes(Path(file_obj.name).read_bytes())
    df = read_tabular(str(dest))
    inspect = inspect_frame(df, file_path=str(dest))
    try:
        result = apply_plan(df, plan_json)
    except Exception as exc:  # noqa: BLE001
        return f"Error: {exc}", inspect, None
    preview = preview_dict(result)
    out = write_csv(result["frame"], "filtered_output.csv")
    return preview["summary"] + f"\nSaved: {out}", inspect, str(out)


def build() -> gr.Blocks:
    cfg = get_model_config()
    with gr.Blocks(title="Ledger — Excel Data Agent") as demo:
        gr.Markdown(
            f"# Ledger\nUpload Excel, paste a FilterGroup JSON, download CSV. "
            f"Model (for `adk web`): `{cfg.resolved_model_id()}`"
        )
        file_in = gr.File(label="Excel / CSV", file_types=[".xlsx", ".xls", ".csv"])
        plan = gr.Textbox(
            label="FilterGroup JSON",
            lines=10,
            value=json.dumps(
                {
                    "logic": "and",
                    "conditions": [{"column": "Age", "op": "between", "value": [25, 40]}],
                },
                indent=2,
            ),
        )
        go = gr.Button("Apply filter")
        summary = gr.Textbox(label="Summary")
        inspect = gr.JSON(label="Inspect")
        download = gr.File(label="CSV")
        go.click(_handle, inputs=[file_in, plan], outputs=[summary, inspect, download])
    return demo


if __name__ == "__main__":
    build().launch(server_name="0.0.0.0", server_port=7860)
