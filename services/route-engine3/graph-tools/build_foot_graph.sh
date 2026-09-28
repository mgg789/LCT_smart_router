#!/usr/bin/env bash
# Build the vendored MKAD pedestrian/cyclist OSRM graph (../graphs/foot).
#
# Stages:
#   cut    (host)  pyosmium pass over the Central Federal District extract,
#                  keeping walk/cycle ways inside the MKAD ring +500 m —
#                  run cut_mkad_foot_graph.py first (see its docstring);
#   merge  (docker) osmium cat nodes+ways into one valid pbf;
#   graph  (docker) osrm-extract with profiles/pedestrian.lua, then
#                  osrm-partition and osrm-customize (MLD).
#
# Docker image: local/osrm-mkad (osrm-backend v26.x + osmium-tool), the same
# image the car graph was built with — an older osrm major cannot read the
# resulting fingerprint. On success the graph pages land in ../graphs/foot/
# next to the graph.json metadata.
#
# Usage: ./build_foot_graph.sh [cut|merge|graph|all]

set -euo pipefail
cd "$(dirname "$0")"

IMG=local/osrm-mkad
BUILD=build
OUT=../graphs/foot
PBF="$BUILD/moscow-mkad-foot.osm.pbf"
stage="${1:-all}"

if [[ $stage == all || $stage == cut ]]; then
  # Host pass; the venv with pyosmium+shapely lives in the car-graph project.
  "${FOOT_PY:-$HOME/Projects/LCT/moscow-road-graph/.venv/bin/python}" \
    cut_mkad_foot_graph.py
fi

if [[ $stage == all || $stage == merge ]]; then
  # Nodes must precede ways in a valid OSM pbf.
  mkdir -p "$OUT"
  docker run --rm -v "$PWD/$BUILD":/build -w /build "$IMG" \
    osmium cat /build/moscow-mkad-foot-nodes.osm.pbf \
               /build/moscow-mkad-foot-ways.osm.pbf \
               -o /build/moscow-mkad-foot.osm.pbf --overwrite
fi

if [[ $stage == all || $stage == graph ]]; then
  docker run --rm -v "$PWD":/tools -v "$PWD/$BUILD":/build -w /build "$IMG" \
    osrm-extract -p /tools/profiles/pedestrian.lua /build/moscow-mkad-foot.osm.pbf
  docker run --rm -v "$PWD/$BUILD":/build -w /build "$IMG" \
    osrm-partition /build/moscow-mkad-foot.osrm
  docker run --rm -v "$PWD/$BUILD":/build -w /build "$IMG" \
    osrm-customize /build/moscow-mkad-foot.osrm
  cp "$BUILD"/moscow-mkad-foot.osrm* "$OUT"/
  if [ ! -f "$OUT/graph.json" ]; then
    cat > "$OUT/graph.json" <<'JSON'
{
  "graph_id": "foot",
  "profile": "foot",
  "map_version": "moscow-mkad-foot-v1",
  "max_table_size": 4096,
  "speeds_kmh": {"walk": 5.0, "bike": 15.0},
  "comment": "MKAD pedestrian/cyclist graph (osrm v26.x, MLD, pedestrian.lua)"
}
JSON
  fi
  echo "graph pages copied to $OUT"
fi
