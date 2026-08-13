"""Command-line helpers that do not need a running LLM.

Examples
--------
python -m excel_data_agent.cli inspect samples/employees.xlsx
python -m excel_data_agent.cli filter samples/employees.xlsx \
    '{"logic":"and","conditions":[{"column":"Age","op":"between","value":[25,40]}]}'
python -m excel_data_agent.cli anomalies samples/employees.xlsx
python -m excel_data_agent.cli dist samples/employees.xlsx --column Salary
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Allow `python -m excel_data_agent.cli` from the repo root.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Excel Data Agent — deterministic tools")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ins = sub.add_parser("inspect", help="Inspect a workbook")
    p_ins.add_argument("file")

    p_flt = sub.add_parser("filter", help="Apply a FilterGroup JSON string")
    p_flt.add_argument("file")
    p_flt.add_argument("plan")
    p_flt.add_argument("-o", "--output", default="filtered_output.csv")
    p_flt.add_argument("--preview", action="store_true")

    p_an = sub.add_parser("anomalies", help="Detect anomalies")
    p_an.add_argument("file")
    p_an.add_argument("--column", default="")

    p_ds = sub.add_parser("dist", help="Recommend distributions")
    p_ds.add_argument("file")
    p_ds.add_argument("--column", default="")

    p_ls = sub.add_parser("ls", help="List available files")

    args = parser.parse_args(argv)

    if args.cmd == "inspect":
        from excel_data_agent.tools.inspect import inspect_excel

        print(json.dumps(inspect_excel(args.file), indent=2, default=str))
        return 0
    if args.cmd == "filter":
        from excel_data_agent.tools.filter import filter_excel, preview_filter

        fn = preview_filter if args.preview else filter_excel
        kwargs = {"file_path": args.file, "filter_conditions": args.plan}
        if not args.preview:
            kwargs["output_filename"] = args.output
        print(json.dumps(fn(**kwargs), indent=2, default=str))
        return 0
    if args.cmd == "anomalies":
        from excel_data_agent.tools.analyze import detect_anomalies

        print(json.dumps(detect_anomalies(args.file, args.column), indent=2, default=str))
        return 0
    if args.cmd == "dist":
        from excel_data_agent.tools.analyze import explain_distribution

        print(json.dumps(explain_distribution(args.file, args.column), indent=2, default=str))
        return 0
    if args.cmd == "ls":
        from excel_data_agent.tools.files import list_available_files

        print(json.dumps(list_available_files(), indent=2, default=str))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
