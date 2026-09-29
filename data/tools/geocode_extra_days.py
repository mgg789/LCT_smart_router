#!/usr/bin/env python3
"""Geocode the extra-days address lists into additional geocode packages.

Reads `out/addresses-<region>.json` produced by transform_extra_days.py (normalized
address → original table spelling), skips every address the day-1 packages already
cover (the app's tabular import merges all geocoded/*.json files), geocodes the rest
through the shared geocode_locationiq machinery (ladder + MANUAL_QUERIES +
best-candidate + cache), and writes package-schema files:

    out/geocodes-<region>-extra-days.json
    entries: [{address: <table spelling>, node_id: <region>-extra-NNN,
               location, match_level: class:type, source: LocationIQ …}]
    version: official-<region>-extra-days-geocodes-locationiq-2026-09-29

Run with LOCATIONIQ_RPM=110 for the raised plan budget (default 60).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
# Works from the scratch workspace (geocode_locationiq.py one level up) and from the
# repo layout data/tools/ where all three tools sit together.
for _candidate in (HERE, ROOT):
    if (_candidate / "geocode_locationiq.py").exists():
        sys.path.insert(0, str(_candidate))
        break

from geocode_locationiq import (  # noqa: E402
    MANUAL_QUERIES,
    ENTRY_SOURCE,
    ORIGINALS,
    candidate_score,
    geocode_query,
    load_json,
    normalize_address,
    query_variants,
    save_json,
)
from transform_extra_days import region_of  # noqa: E402

# Extra-days artifacts live in this folder's own out/ (the day-1 module's OUT is
# geo-locationiq/out — deliberately not reused, only the query cache is shared).
EXTRA_OUT = HERE / "out"

PACKAGE_VERSION = "official-{region}-extra-days-geocodes-locationiq-2026-09-29"
PACKAGE_SOURCE = (
    "LocationIQ (Nominatim/OpenStreetMap) forward geocoding of the organizer extra-days "
    "address catalogue (28–29.09.2026), cached offline 2026-09-29."
)

REGIONS = ("east", "south_central", "southeast")
CACHE_PATH = ROOT / "cache.json"
RESOLVED_EXTRA = HERE / "resolved-extra.json"


def day1_catalog() -> dict[str, dict]:
    """Union of every day-1 package point, keyed by normalized address."""
    catalog: dict[str, dict] = {}
    for path in sorted(ORIGINALS.glob("*.json")):
        package = json.loads(path.read_text(encoding="utf-8"))
        for entry in package["entries"]:
            catalog[normalize_address(entry["address"])] = entry["location"]
    return catalog


def main() -> int:
    token_env = "LOCATIONIQ_TOKEN"
    import os

    token = os.environ.get(token_env, "").strip()
    if not token:
        print(f"{token_env} environment variable is required", file=sys.stderr)
        return 2

    catalog = day1_catalog()
    print(f"day-1 catalog covers {len(catalog)} normalized addresses")
    cache: dict = load_json(CACHE_PATH, {})  # type: ignore[assignment]
    resolved: dict = load_json(RESOLVED_EXTRA, {})  # type: ignore[assignment]

    totals = {"resolved": 0, "reused": 0, "unresolved": 0}
    all_unresolved: list[dict] = []
    report_rows: list[str] = []
    for region in REGIONS:
        addresses: dict[str, str] = json.loads(
            (EXTRA_OUT / f"addresses-{region}.json").read_text(encoding="utf-8")
        )
        entries: list[dict] = []
        unresolved: list[str] = []
        index = 0
        for norm, spelling in addresses.items():
            if norm in catalog:
                totals["reused"] += 1
                continue
            result = resolved.get(norm)
            if result is None:
                best: dict | None = None
                best_score = -1
                best_importance = -1.0
                used_variant: str | None = None
                ladder = MANUAL_QUERIES.get(norm, []) + query_variants(spelling)
                for variant in ladder:
                    status, candidates = geocode_query(variant, token, cache)
                    if status != 200:
                        continue
                    for candidate in candidates:
                        score = candidate_score(candidate)
                        importance = float(candidate.get("importance") or 0.0)
                        if score < best_score or (
                            score == best_score and importance <= best_importance
                        ):
                            continue
                        best, best_score, best_importance = candidate, score, importance
                        used_variant = variant
                if best is None or best_score == 0:
                    unresolved.append(spelling)
                    continue
                result = {
                    "lat": float(best["lat"]),
                    "lon": float(best["lon"]),
                    "class": best.get("class", ""),
                    "type": best.get("type", ""),
                    "display_name": best.get("display_name", ""),
                    "variant": used_variant,
                }
                resolved[norm] = result
                save_json(RESOLVED_EXTRA, resolved)
            entries.append(
                {
                    "address": spelling,
                    "node_id": f"{region}-extra-{index:03d}",
                    "location": {"lat": result["lat"], "lon": result["lon"]},
                    "match_level": f"{result['class']}:{result['type']}"
                    if result["class"]
                    else result["type"],
                    "source": ENTRY_SOURCE,
                }
            )
            index += 1
            totals["resolved"] += 1
            if not (result["class"].startswith("building") or result["class"] == "office"):
                report_rows.append(
                    f"- {region} {spelling} → {result['class']}:{result['type']} "
                    f"({result['lat']}, {result['lon']})"
                )
        package = {
            "schema_version": "1.0",
            "version": PACKAGE_VERSION.format(region=region),
            "source": PACKAGE_SOURCE,
            "entries": entries,
        }
        (EXTRA_OUT / f"geocodes-{region}-extra-days.json").write_text(
            json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(
            f"{region}: new={len(entries)} reused_from_day1="
            f"{sum(1 for n in addresses if n in catalog)} unresolved={len(unresolved)}"
        )
        all_unresolved.extend({"region": region, "address": a} for a in unresolved)

    if report_rows or all_unresolved:
        lines = ["# Extra-days geocoding: non-house matches / unresolved", ""]
        lines.extend(report_rows)
        if all_unresolved:
            lines.extend(["", "## Unresolved", ""])
            lines.extend(f"- {item['region']}: {item['address']}" for item in all_unresolved)
        (EXTRA_OUT / "geocode-extra-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("totals:", totals, "| unresolved:", len(all_unresolved))
    return 0 if not all_unresolved else 1


if __name__ == "__main__":
    sys.exit(main())
