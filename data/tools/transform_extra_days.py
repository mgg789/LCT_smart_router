#!/usr/bin/env python3
"""Transform the organizer's "Доп дни" (extra days) exports into clean day tables.

What the raw exports look like (audited 2026-09-29):

- Six cp1251 CSVs named «<регион> день N» — but the filenames lie: the юго-восток
  pair is swapped (день 2 holds 29.09 rows, день 3 holds 28.09), and both
  юго-центр files carry only 28.09 data (day 3 is a second snapshot of day 2).
- Request ids repeat across exports: 76 ids are byte-identical snapshots of the
  same row, 13 ids are genuine reschedules (the same BK number with a moved
  window on the next day and a newer status).
- All dates parse as dd.mm.yyyy H:MM; every row is 28.09 or 29.09.2026.

Transformation rules (documented in the repo README next to the outputs):

1. The day of a row comes from its own «Начало» date, never from the filename.
2. Rows are deduplicated by id: identical payloads collapse to one row; distinct
   payloads (the reschedules) are kept, one per day table.
3. Output: `<region>-day-2026-09-28.csv` / `<region>-day-2026-09-29.csv`,
   cp1251 + `;`, original column order preserved. Nothing else is altered:
   statuses, work types and address spellings stay as the organizer wrote them.

Usage: python3 transform_extra_days.py   (paths relative to this folder)
Outputs: out/<region>-day-<date>.csv, out/transform-report.md,
         out/addresses-<region>.json (normalized new-address lists for geocoding)
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
OUT = HERE / "out"
# Works both from the scratch workspace (tool lives next to geocode_locationiq.py's
# folder) and from the repo layout data/tools/ where all three tools sit together.
for _candidate in (HERE, HERE.parent):
    if (_candidate / "geocode_locationiq.py").exists():
        sys.path.insert(0, str(_candidate))
        break
from geocode_locationiq import normalize_address  # noqa: E402

DAY_RE = re.compile(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})\s")

FILE_REGION: list[tuple[str, str]] = [
    # Match order matters: check юго-* before the bare восток.
    ("юго-центр", "south_central"),
    ("юго", "southeast"),
    ("восток", "east"),
]


def region_of(filename: str) -> str:
    for needle, region in FILE_REGION:
        if filename.startswith(needle):
            return region
    raise ValueError(f"unknown region for file: {filename}")


def row_day(row: dict[str, str]) -> str:
    """ISO date of the row's «Начало» — the day the work actually belongs to."""
    match = DAY_RE.match((row.get("Начало") or "").strip())
    if not match:
        raise ValueError(f"row without a parsable «Начало»: {row}")
    day, month, year = match.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def payload(row: dict[str, str]) -> tuple:
    """Full-row fingerprint for snapshot deduplication."""
    return tuple(sorted((key, (value or "").strip()) for key, value in row.items()))


def main() -> int:
    OUT.mkdir(exist_ok=True)
    # First pass: every distinct row in the whole export, tagged with region/day/file.
    distinct: dict[tuple[str, str, str], tuple] = {}
    fingerprints_by_id: dict[tuple[str, str], list[tuple]] = {}
    moved_ids: set[str] = set()
    columns_by_region_day: dict[tuple[str, str], list[str]] = {}
    snapshots_dropped = 0

    for path in sorted(RAW.glob("*.csv")):
        region = region_of(path.name)
        with open(path, encoding="cp1251", newline="") as handle:
            rows = list(csv.DictReader(handle, delimiter=";"))
        if rows:
            header = list(rows[0].keys())
        for row in rows:
            day = row_day(row)
            request_id = (row.get("Заявка") or "").strip()
            fingerprint = payload(row)
            history = fingerprints_by_id.setdefault((region, request_id), [])
            if any(previous == fingerprint for previous in history):
                snapshots_dropped += 1
                continue
            if history:
                # Same BK number, different content in another export: a reschedule.
                moved_ids.add(request_id)
            history.append(fingerprint)
            distinct[(region, day, request_id)] = fingerprint
            columns_key = (region, day)
            if columns_key not in columns_by_region_day:
                columns_by_region_day[columns_key] = header
            else:
                merged = columns_by_region_day[columns_key]
                for column in header:
                    if column not in merged:
                        merged.append(column)

    # Second pass: write one table per (region, day) in the original column order.
    tables: dict[tuple[str, str], list[dict[str, str]]] = {}
    for (region, day, _request_id), fingerprint in distinct.items():
        row = dict(fingerprint)
        tables.setdefault((region, day), []).append(row)

    report = [
        "# Extra-days transform report",
        "",
        "Filenames lied about the days; rows are regrouped by their own «Начало» date.",
        f"Identical snapshots dropped: {snapshots_dropped}",
        f"Rescheduled ids kept in two day tables: {len(moved_ids)}"
        + (f" ({', '.join(sorted(moved_ids))})" if moved_ids else ""),
        "",
        "| Table | Rows |",
        "|---|---|",
    ]
    for (region, day), rows in sorted(tables.items()):
        name = f"{region}-day-{day}.csv"
        if not re.fullmatch(r"[a-z_]+-day-\d{4}-\d{2}-\d{2}\.csv", name):
            raise ValueError(f"output name left the allowed pattern: {name}")
        columns = columns_by_region_day[(region, day)]
        with open(OUT / name, "w", encoding="cp1251", newline="") as handle:
            writer = csv.DictWriter(
                handle, fieldnames=columns, delimiter=";", extrasaction="ignore"
            )
            writer.writeheader()
            writer.writerows(rows)
        report.append(f"| {name} | {len(rows)} |")

    # Address lists per region for the geocoding step (normalized, deduplicated,
    # already-known day-1 catalog addresses are kept too — the join needs them).
    for region in ("east", "south_central", "southeast"):
        addresses: dict[str, str] = {}
        for (table_region, _day), rows in tables.items():
            if table_region != region:
                continue
            for row in rows:
                address = (row.get("Адрес") or "").strip()
                if address:
                    addresses.setdefault(normalize_address(address), address)
        (OUT / f"addresses-{region}.json").write_text(
            json.dumps(addresses, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
        )

    (OUT / "transform-report.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("\n".join(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
