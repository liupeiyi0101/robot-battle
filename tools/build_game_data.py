from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import openpyxl


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_FILE = ROOT / "public" / "data" / "game-data.json"
WORKBOOKS = [
    "pilot_data.xlsx",
    "unit_data.xlsx",
    "map_data.xlsx",
    "buff_data.xlsx",
]


def normalize_cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def sheet_to_records(sheet) -> list[dict[str, Any]]:
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        return []

    headers = [str(cell).strip() if cell is not None else "" for cell in rows[0]]
    header_indexes = [(index, header) for index, header in enumerate(headers) if header]
    records: list[dict[str, Any]] = []

    for row in rows[1:]:
        record = {
            header: normalize_cell(row[index] if index < len(row) else "")
            for index, header in header_indexes
        }
        if any(value != "" for value in record.values()):
            records.append(record)
    return records


def workbook_to_json(path: Path) -> dict[str, list[dict[str, Any]]]:
    workbook = openpyxl.load_workbook(path, data_only=True)
    return {sheet.title: sheet_to_records(sheet) for sheet in workbook.worksheets}


def main() -> None:
    data = {}
    for workbook_name in WORKBOOKS:
        path = ROOT / workbook_name
        if path.exists():
            data[workbook_name] = workbook_to_json(path)

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_FILE}")
    for workbook_name, sheets in data.items():
        print(f"{workbook_name}:")
        for sheet_name, rows in sheets.items():
            print(f"  {sheet_name}: {len(rows)} rows")


if __name__ == "__main__":
    main()
