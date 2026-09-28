"""Merge cached Overpass `out geom` responses into the attributed offline city map.

Usage: python apps/web/scripts/prepare-basemap.py BASE_JSON WEST_JSON NORTH_JSON
The output is ODbL map data, not a route or a routing matrix. No network calls are made.
"""

import argparse
import hashlib
import json
from pathlib import Path

BOUNDS = [37.35, 54.80, 38.20, 55.93]
SOURCE_AREAS = [
    ("official-regions", [37.50, 54.80, 38.20, 55.81], "https://maps.mail.ru/osm/tools/overpass/api/interpreter", 50, 134217728),
    ("mkad-west", [37.35, 55.55, 37.50, 55.93], "https://overpass.kumi.systems/api/interpreter", 180, 134217728),
    ("mkad-north", [37.50, 55.81, 37.86, 55.93], "https://overpass.kumi.systems/api/interpreter", 180, 134217728),
]


def query(bounds: list[float], timeout: int, maxsize: int) -> str:
    """Describe the exact selected OSM classes and bounding rectangle."""
    west, south, east, north = bounds
    bbox = f"({south:.2f},{west:.2f},{north:.2f},{east:.2f})"
    return (
        f"[out:json][timeout:{timeout}][maxsize:{maxsize}];("
        + "".join(
            f'way[{tag}]{bbox};'
            for tag in (
                '"highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)(_link)?$"',
                '"waterway"~"^(river|canal)$"',
                '"natural"="water"',
                '"leisure"="park"',
            )
        )
        + ");out geom;"
    )


def simplify(points: list[list[float]], epsilon: float = 0.00004) -> list[list[float]]:
    """Ramer-Douglas-Peucker display simplification, at most 4.5 m in latitude."""
    if len(points) <= 2:
        return points
    keep = {0, len(points) - 1}
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        ax, ay = points[first]
        bx, by = points[last]
        dx, dy = bx - ax, by - ay
        length = dx * dx + dy * dy
        distance, selected = epsilon * epsilon, None
        for index in range(first + 1, last):
            x, y = points[index]
            t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / length)) if length else 0.0
            error = (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2
            if error > distance:
                distance, selected = error, index
        if selected is not None:
            keep.add(selected)
            stack.extend([(first, selected), (selected, last)])
    result = [points[index] for index in sorted(keep)]
    # Retain valid small closed rings, even if below the display tolerance.
    return points if points[0] == points[-1] and len(result) < 4 else result


def convert(source: dict) -> dict:
    """Keep actual OSM geometry and minimal display tags; reject partial/error responses."""
    if source.get("remark") or not source.get("elements"):
        raise ValueError("Incomplete Overpass response")
    features = []
    for way in source["elements"]:
        tags = way.get("tags", {})
        points = [
            [round(p["lon"], 6), round(p["lat"], 6)] for p in way.get("geometry", [])
        ]
        if len(points) < 2:
            continue
        points = simplify(points)
        road = tags.get("highway")
        kind = (
            "road"
            if road
            else "water"
            if tags.get("natural") == "water" or tags.get("waterway")
            else "park"
        )
        area = kind != "road" and len(points) >= 4 and points[0] == points[-1]
        features.append(
            {
                "type": "Feature",
                "id": way["id"],
                "properties": {
                    "kind": kind,
                    "class": road or "",
                    "name": tags.get("name", ""),
                },
                "geometry": {
                    "type": "Polygon" if area else "LineString",
                    "coordinates": [points] if area else points,
                },
            }
        )
    if len(features) < 100:
        raise ValueError("Unexpectedly small extract")
    return {"type": "FeatureCollection", "features": features}


def main() -> None:
    """Write the map and provenance manifest to the public, offline-cached asset directory."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", type=Path, nargs=3)
    args = parser.parse_args()
    sources = []
    ways = {}
    for path, (name, bounds, endpoint, timeout, maxsize) in zip(args.inputs, SOURCE_AREAS, strict=True):
        raw = path.read_bytes()
        source = json.loads(raw)
        if source.get("remark") or not source.get("elements"):
            raise ValueError(f"Incomplete Overpass response: {name}")
        # The established regional extract is newer than the fallback mirror.
        # Keep its version for overlapping OSM ids; the strips only fill gaps.
        for way in source["elements"]:
            ways.setdefault(way["id"], way)
        sources.append({
            "area": name,
            "endpoint": endpoint,
            "bounds": bounds,
            "query": query(bounds, timeout, maxsize),
            "sourceTimestamp": source["osm3s"]["timestamp_osm_base"],
            "sourceSha256": hashlib.sha256(raw).hexdigest(),
            "elementCount": len(source["elements"]),
        })
    data = convert({"elements": [ways[id] for id in sorted(ways)]})
    output = Path(__file__).resolve().parents[1] / "public/maps"
    output.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
    ).encode()
    (output / "official-regions.geojson").write_bytes(payload)
    manifest = {
        "source": "OpenStreetMap contributors",
        "license": "ODbL-1.0",
        "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
        "attributionUrl": "https://www.openstreetmap.org/copyright",
        "bounds": BOUNDS,
        "regions": ["inside_mkad", "east", "south_central", "southeast"],
        "sources": sources,
        "fileSha256": hashlib.sha256(payload).hexdigest(),
        "featureCount": len(data["features"]),
        "transform": "OSM ways only; selected road/water/park tags; coordinates rounded to 6 decimals then simplified at 0.00004 degrees (<=4.5 m latitude). Ways intersect the query bbox; full way geometry may extend outside it. No buildings or address guarantee.",
    }
    (output / "manifest.json").write_text(
        "{\n" + ",\n".join(
            f"  {json.dumps(key)}: {json.dumps(value, ensure_ascii=False)}"
            for key, value in manifest.items()
        ) + "\n}\n", encoding="utf-8"
    )
    print(f"Saved {len(data['features'])} OSM features, {len(payload)} bytes")


if __name__ == "__main__":
    main()
