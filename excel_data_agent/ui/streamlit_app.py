"""Optional Streamlit wrapper.

    streamlit run excel_data_agent/ui/streamlit_app.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import pandas as pd  # noqa: E402
import streamlit as st  # noqa: E402

from excel_data_agent.config import UPLOAD_DIR, ensure_directories, get_model_config  # noqa: E402
from excel_data_agent.core.excel_io import read_tabular  # noqa: E402
from excel_data_agent.core.filter_engine import apply_plan, preview_dict  # noqa: E402
from excel_data_agent.core.inspect_engine import inspect_frame  # noqa: E402
from excel_data_agent.tools.analyze import detect_anomalies, explain_distribution  # noqa: E402


def _save_upload(uploaded) -> Path:
    ensure_directories()
    dest = UPLOAD_DIR / uploaded.name
    dest.write_bytes(uploaded.getbuffer())
    return dest


def main() -> None:
    st.set_page_config(page_title="Ledger — Excel Data Agent", layout="wide")
    cfg = get_model_config()
    st.title("Ledger")
    st.caption(
        "Upload an Excel file, describe the rows you need, download a clean CSV. "
        f"Configured model: `{cfg.resolved_model_id()}` via `{cfg.provider}`."
    )

    uploaded = st.file_uploader("Excel / CSV", type=["xlsx", "xls", "xlsm", "csv"])
    if uploaded is None:
        st.info("Please upload your Excel file, then describe the data you need.")
        return

    path = _save_upload(uploaded)
    df = read_tabular(str(path))
    report = inspect_frame(df, file_path=str(path))

    left, right = st.columns([1, 1.4])
    with left:
        st.subheader("Inspect")
        st.write(f"{report['n_rows']} rows × {report['n_cols']} columns")
        st.json(
            {
                "columns": [
                    {"name": c["name"], "kind": c["kind"], "meaning": c["meaning"]}
                    for c in report["columns"]
                ],
                "filter_strategy": report["filter_strategy"],
            }
        )

        prompt = st.text_area(
            "Filter in natural language — or paste FilterGroup JSON",
            placeholder='Age between 25 and 40 and Department is Sales',
            height=100,
        )
        raw_json = st.text_area(
            "FilterGroup JSON (required for this wrapper; the ADK agent writes this for you)",
            value=json.dumps(
                {
                    "logic": "and",
                    "conditions": [
                        {"column": report["column_names"][0], "op": "eq", "value": ""}
                    ],
                },
                indent=2,
            ),
            height=180,
        )
        do_filter = st.button("Apply filter", type="primary")

    filtered = df
    summary = None
    if do_filter:
        try:
            result = apply_plan(df, raw_json)
            filtered = result["frame"]
            summary = preview_dict(result)
        except Exception as exc:  # noqa: BLE001
            st.error(str(exc))

    with right:
        st.subheader("Result")
        if summary:
            st.success(summary["summary"])
            st.caption("Hierarchy trace")
            st.json(summary["trace"])
        st.dataframe(filtered, use_container_width=True, height=360)
        csv_bytes = filtered.to_csv(index=False).encode("utf-8")
        st.download_button("Download CSV", data=csv_bytes, file_name="filtered_output.csv", mime="text/csv")

        tabs = st.tabs(["Anomalies", "Distributions", "Prompt reminder"])
        with tabs[0]:
            if st.button("Run anomaly detection"):
                st.json(detect_anomalies(str(path)))
        with tabs[1]:
            if st.button("Fit distributions"):
                st.json(explain_distribution(str(path)))
        with tabs[2]:
            st.write(prompt or "Describe the slice you want, then translate it to JSON (or use `adk web`).")


if __name__ == "__main__":
    main()
