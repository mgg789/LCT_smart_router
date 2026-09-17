"""Convert one cached Overpass `out geom` response into the attributed offline demo map.

Usage: python apps/web/scripts/prepare-basemap.py INPUT_JSON
The output is ODbL map data, not a route or a routing matrix. No network calls are made.
"""

import argparse
import hashlib
import json
from pathlib import Path

BOUNDS = [37.63, 55.68, 37.82, 55.76]
QUERY = '[out:json][timeout:40];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)(_link)?$"](55.68,37.63,55.76,37.82);way["waterway"~"^(river|canal)$"](55.68,37.63,55.76,37.82);way["natural"="water"](55.68,37.63,55.76,37.82);way["landuse"~"^(forest|grass)$"](55.68,37.63,55.76,37.82);way["leisure"="park"](55.68,37.63,55.76,37.82););out geom;'


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
    parser.add_argument("input", type=Path)
    args = parser.parse_args()
    raw = args.input.read_bytes()
    source = json.loads(raw)
    data = convert(source)
    output = Path(__file__).resolve().parents[1] / "public/maps"
    output.mkdir(parents=True, exist_ok=True)
    payload = (
        json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
    ).encode()
    (output / "east-demo.geojson").write_bytes(payload)
    manifest = {
        "source": "OpenStreetMap contributors",
        "license": "ODbL-1.0",
        "licenseUrl": "https://opendatacommons.org/licenses/odbl/1-0/",
        "attributionUrl": "https://www.openstreetmap.org/copyright",
        "endpoint": "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
        "sourceTimestamp": source["osm3s"]["timestamp_osm_base"],
        "bounds": BOUNDS,
        "query": QUERY,
        "sourceSha256": hashlib.sha256(raw).hexdigest(),
        "fileSha256": hashlib.sha256(payload).hexdigest(),
        "featureCount": len(data["features"]),
        "transform": "OSM ways only; selected road/water/park tags; coordinates rounded to 6 decimals. Ways intersect the query bbox; full way geometry may extend outside it. No buildings or address guarantee.",
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Saved {len(data['features'])} OSM features, {len(payload)} bytes")


if __name__ == "__main__":
    main()
