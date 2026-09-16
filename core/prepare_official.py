"""Prepare transparent offline resources for official-dataset acceptance scenarios."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path

from core.contracts import GeoPoint
from core.geo import haversine_m
from core.official import OfficialScenarioConfig

_SOUTH_CENTRAL_CENTROIDS = {
    "Даниловский": GeoPoint(lat=55.704, lon=37.635),
    "Академический": GeoPoint(lat=55.687, lon=37.573),
    "Котловка": GeoPoint(lat=55.674, lon=37.596),
    "Зюзино": GeoPoint(lat=55.656, lon=37.573),
    "Хамовники": GeoPoint(lat=55.732, lon=37.573),
    "Нагатино - Садовники": GeoPoint(lat=55.674, lon=37.648),
    "Замоскворечье": GeoPoint(lat=55.731, lon=37.632),
    "Нагатинский Затон": GeoPoint(lat=55.683, lon=37.692),
    "Нагорный": GeoPoint(lat=55.664, lon=37.611),
    "Донской": GeoPoint(lat=55.700, lon=37.609),
    "Гагаринский": GeoPoint(lat=55.690, lon=37.544),
}
_SOUTH_CENTRAL_OFFICE = GeoPoint(lat=55.655, lon=37.610)


def _read_rows(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="cp1251", newline="") as handle:
        return list(csv.DictReader(handle, delimiter=";"))


def _project(address: str, district: str) -> GeoPoint:
    """Create deterministic address-separated points around an explicit district anchor."""
    normalized = district.removeprefix("GPON ")
    if normalized not in _SOUTH_CENTRAL_CENTROIDS:
        raise ValueError(f"missing centroid for district: {district}")
    digest = hashlib.sha256(address.encode("utf-8")).digest()
    lat_offset = (int.from_bytes(digest[:2], "big") / 65535 - 0.5) * 0.008
    lon_offset = (int.from_bytes(digest[2:4], "big") / 65535 - 0.5) * 0.012
    anchor = _SOUTH_CENTRAL_CENTROIDS[normalized]
    return GeoPoint(lat=round(anchor.lat + lat_offset, 6), lon=round(anchor.lon + lon_offset, 6))


def prepare_south_central_fixture(dataset_dir: Path, scenario_dir: Path) -> None:
    """Write deterministic geocodes and a complete approximate matrix for acceptance.

    Args:
        dataset_dir: Directory containing the organizer's cp1251 CSV archive.
        scenario_dir: Directory containing the checked scenario config and outputs.

    Raises:
        ValueError: If the source/config drifts or a district has no explicit anchor.
    """
    config = OfficialScenarioConfig.model_validate_json((scenario_dir / "config.json").read_bytes())
    if config.region != "south_central":
        raise ValueError("this preparation profile is only for south_central")
    rows = _read_rows(dataset_dir / config.synthetic_file)
    requests = [row for row in rows if row["Заявка"].isdigit()]
    offices = [row for row in rows if row["Заявка"].strip().casefold() == "адрес офиса"]
    if len(requests) != config.expected_request_count or len(offices) != 1:
        raise ValueError("official source count or office marker drift")

    address_points: dict[str, GeoPoint] = {}
    for row in requests:
        point = _project(row["Адрес"], row["Район"])
        previous = address_points.setdefault(row["Адрес"], point)
        if previous != point:
            raise ValueError("one address maps to multiple districts")
    office_address = offices[0]["Тип заявки BK"]
    address_points[office_address] = _SOUTH_CENTRAL_OFFICE

    entries = []
    node_ids = []
    for index, (address, point) in enumerate(sorted(address_points.items())):
        node_id = f"south-central-{index:03d}"
        node_ids.append(node_id)
        entries.append(
            {
                "address": address,
                "node_id": node_id,
                "location": point.model_dump(),
                "match_level": "district_centroid_projection",
            }
        )
    points = [GeoPoint.model_validate(entry["location"]) for entry in entries]
    distances = []
    durations = []
    for source, source_point in enumerate(points):
        distance_row = []
        duration_row = []
        for target, target_point in enumerate(points):
            if source == target:
                distance_row.append(0)
                duration_row.append(0)
                continue
            distance = math.ceil(haversine_m(source_point, target_point) * 1.25)
            distance_row.append(distance)
            duration_row.append(max(1, math.ceil(distance / (28 * 1000 / 3600))))
        distances.append(distance_row)
        durations.append(duration_row)

    geocodes = {
        "schema_version": "1.0",
        "source": (
            "Deterministic district-centroid projection for offline Router acceptance; "
            "not rooftop geocoding."
        ),
        "entries": entries,
    }
    matrix = {
        "schema_version": "1.0",
        "version": "official-south-central-centroid-road-v1",
        "source": (
            "Offline acceptance approximation: haversine x1.25 at constant 28 km/h; "
            "not a production road matrix."
        ),
        "node_ids": node_ids,
        "durations_sec": durations,
        "distances_m": distances,
    }
    scenario_dir.mkdir(parents=True, exist_ok=True)
    (scenario_dir / "geocodes.json").write_text(
        json.dumps(geocodes, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (scenario_dir / "road-matrix.json").write_text(
        json.dumps(matrix, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> None:
    """Regenerate the checked South-central acceptance resources."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-dir", type=Path, default=Path("data/dataset/anonymized"))
    parser.add_argument(
        "--scenario-dir", type=Path, default=Path("core/scenarios/south-central-v1")
    )
    args = parser.parse_args()
    prepare_south_central_fixture(args.dataset_dir, args.scenario_dir)


if __name__ == "__main__":
    main()
