#!/usr/bin/env python3
"""Cut the pedestrian/cyclist graph inside the buffered MKAD polygon.

Host-side pass over the Central Federal District extract (same tactic as the
car graph in ~/Projects/LCT/moscow-road-graph: the 837 MB pbf does not fit the
Docker VM). Selection keeps every way that carries pedestrian or cyclist
infrastructure:

- highway in the walk/cycle set (footway, pedestrian, steps, path, cycleway,
  living_street, track, bridleway, corridor, pier, platform, road);
- any other highway way explicitly tagged sidewalk=* (the walk follows the
  carriageway geometry when no separate sidewalk way is mapped);
- any highway way tagged foot=yes/designated/permissive.

Turn-restriction relations are dropped: pedestrian routing is unaffected by
vehicle turn restrictions, and the car pipeline proved they survive OSRM
extraction only partially anyway.

Outputs build/moscow-mkad-foot-ways.osm.pbf and build/moscow-mkad-foot-nodes.osm.pbf;
merge with `osmium cat` (build_foot_graph.sh) into moscow-mkad-foot.osm.pbf.

Usage:
  ~/Projects/LCT/moscow-road-graph/.venv/bin/python cut_mkad_foot_graph.py \
      [--pbf PATH] [--polygon PATH] [--out-dir PATH]
"""

import argparse
import json
from pathlib import Path

import osmium
from shapely.geometry import Point, shape
from shapely.prepared import prep

# Walk/cycle infrastructure kept regardless of extra access tags.
INFRA_HIGHWAYS = {
    "footway",
    "pedestrian",
    "steps",
    "path",
    "cycleway",
    "living_street",
    "track",
    "bridleway",
    "corridor",
    "pier",
    "platform",
    "road",
}
# Carriageways kept only when they carry explicit pedestrian access.
ROAD_HIGHWAYS = {
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "service",
}
SIDEWALK_VALUES = {"yes", "both", "left", "right", "permissive", "crossing"}
FOOT_ACCESS_VALUES = {"yes", "designated", "permissive", "destination"}


def way_selected(tags) -> bool:
    """Decide whether one OSM way belongs in the pedestrian/cyclist graph."""
    highway = tags.get("highway")
    if not highway:
        return False
    if highway in INFRA_HIGHWAYS:
        return True
    if highway in ROAD_HIGHWAYS:
        if tags.get("sidewalk") in SIDEWALK_VALUES:
            return True
        if tags.get("sidewalk:both") in SIDEWALK_VALUES:
            return True
        if (
            tags.get("sidewalk:left") in SIDEWALK_VALUES
            or tags.get("sidewalk:right") in SIDEWALK_VALUES
        ):
            return True
        if tags.get("foot") in FOOT_ACCESS_VALUES:
            return True
    return False


class WayCutter(osmium.SimpleHandler):
    """Write selected ways intersecting the polygon; collect their node ids."""

    def __init__(self, polygon, writer):
        super().__init__()
        self.polygon = prep(polygon)
        self.writer = writer
        self.kept_nodes = set()
        self.kept_ways = 0

    def way(self, w):
        tags = dict(w.tags)
        if not way_selected(tags):
            return
        nodes = list(w.nodes)
        for node in nodes:
            loc = node.location
            if loc.valid() and self.polygon.contains(Point(loc.lon, loc.lat)):
                self.writer.add_way(w)
                self.kept_nodes.update(n.ref for n in nodes)
                self.kept_ways += 1
                return


class NodeWriter(osmium.SimpleHandler):
    """Second, location-free pass: emit only the nodes kept by WayCutter."""

    def __init__(self, kept, writer):
        super().__init__()
        self.kept = kept
        self.writer = writer
        self.written = 0

    def node(self, n):
        if n.id in self.kept:
            self.writer.add_node(n)
            self.written += 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pbf",
        type=Path,
        default=Path.home()
        / "Projects/LCT/moscow-road-graph/data/central-fed-district-latest.osm.pbf",
        help="Central Federal District OSM extract (837 MB)",
    )
    parser.add_argument(
        "--polygon",
        type=Path,
        default=Path.home()
        / "Projects/LCT/moscow-road-graph/data/mkad-buffered.geojson",
        help="MKAD ring +500 m buffer geojson from the car-graph pipeline",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(__file__).resolve().parent / "build",
    )
    args = parser.parse_args()

    if not args.pbf.exists():
        raise SystemExit(f"missing {args.pbf}")
    if not args.polygon.exists():
        raise SystemExit(
            f"missing {args.polygon} — build it with build_mkad_polygon.py"
        )
    polygon = shape(
        json.loads(args.polygon.read_text(encoding="utf-8"))["features"][0]["geometry"]
    )

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out_ways = args.out_dir / "moscow-mkad-foot-ways.osm.pbf"
    out_nodes = args.out_dir / "moscow-mkad-foot-nodes.osm.pbf"

    ways_writer = osmium.SimpleWriter(str(out_ways))
    cutter = WayCutter(polygon, ways_writer)
    cutter.apply_file(str(args.pbf), locations=True, idx="flex_mem")
    ways_writer.close()
    print(f"kept {cutter.kept_ways} walk/cycle ways, {len(cutter.kept_nodes)} nodes")

    nodes_writer = osmium.SimpleWriter(str(out_nodes))
    node_writer = NodeWriter(cutter.kept_nodes, nodes_writer)
    node_writer.apply_file(str(args.pbf))
    nodes_writer.close()
    print(f"wrote {node_writer.written} nodes")


if __name__ == "__main__":
    main()
