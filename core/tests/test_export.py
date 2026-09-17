"""GeoJSON coordinate order and route identity."""

from core.export import plan_geojson
from core.geo import GraphTravel
from core.schedule import baseline


def test_map_export_uses_path_lon_lat(snapshot, graph):
    plan = baseline(snapshot, GraphTravel(graph))
    data = plan_geojson(plan)
    first = data["features"][0]
    assert first["geometry"]["coordinates"][0] == [37.6, 55.75]
    assert first["properties"]["engineer_id"] == "eng-1"
    assert len(first["geometry"]["coordinates"]) == 4
