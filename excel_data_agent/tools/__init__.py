"""ADK FunctionTools for the Excel data agent."""

from excel_data_agent.tools.analyze import analyze_data, detect_anomalies, explain_distribution
from excel_data_agent.tools.files import export_to_csv, list_available_files
from excel_data_agent.tools.filter import filter_excel, preview_filter
from excel_data_agent.tools.inspect import inspect_excel

ALL_TOOLS = [
    inspect_excel,
    filter_excel,
    preview_filter,
    analyze_data,
    detect_anomalies,
    explain_distribution,
    export_to_csv,
    list_available_files,
]

__all__ = [
    "ALL_TOOLS",
    "analyze_data",
    "detect_anomalies",
    "explain_distribution",
    "export_to_csv",
    "filter_excel",
    "inspect_excel",
    "list_available_files",
    "preview_filter",
]
