"""Road direction, path consistency, coordinates and address ambiguity."""

from core.contracts import GeoPoint, RouterTechnicalSettings
from core.geo import AddressCandidate, Gazetteer, GraphTravel, RoadGraph, configure_travel


def test_path_matrix_and_profiles(graph):
    travel = GraphTravel(graph)
    a, b = graph.nodes[0].location, graph.nodes[3].location
    route = travel.quote(a, b, "car")
    assert (route.duration_sec, route.distance_m) == (180, 1800)
    assert route.points == tuple(n.location for n in graph.nodes)
    assert travel.quote(a, b, "walk").duration_sec == 1260
    assert travel.matrix([a, b], "car")[0][1] == route


def test_direction_unreachable_and_unknown_coordinates(graph):
    data = graph.model_dump()
    data["edges"] = [e for e in data["edges"] if int(e["source"]) < int(e["target"])]
    travel = GraphTravel(RoadGraph.model_validate(data))
    assert travel.quote(graph.nodes[3].location, graph.nodes[0].location, "car") is None
    assert travel.quote(GeoPoint(lat=0, lon=0), graph.nodes[0].location, "car") is None
    assert travel.nearest(graph.nodes[0].location, 0)[0] == "0"


def test_graph_version_changes_with_costs(graph):
    data = graph.model_dump()
    data["edges"][0]["duration_sec"]["car"] += 1
    assert GraphTravel(graph).version != GraphTravel(RoadGraph.model_validate(data)).version


def test_technical_travel_modes_preserve_graph_route_and_zero_distance(graph):
    """Timing policy changes seconds only; graph distance and geometry remain authoritative."""
    raw = GraphTravel(graph)
    a, b = graph.nodes[0].location, graph.nodes[3].location
    original = raw.quote(a, b, "car")
    buffered = configure_travel(raw, RouterTechnicalSettings())
    fixed = configure_travel(
        raw, RouterTechnicalSettings(travel_time_mode="fixed_normative")
    )

    assert buffered.quote(a, b, "car").duration_sec == original.duration_sec + 600
    assert fixed.quote(a, b, "car").duration_sec == 1200
    assert buffered.quote(a, b, "car").distance_m == original.distance_m
    assert fixed.quote(a, b, "car").points == original.points
    assert buffered.quote(a, a, "car").duration_sec == 0
    assert fixed.quote(a, a, "car").duration_sec == 0


def test_geocoder_preserves_ambiguity(graph):
    candidates = [
        AddressCandidate(address="Москва, Дом 1", location=n.location, source="test")
        for n in graph.nodes[:2]
    ]
    catalog = Gazetteer(candidates)
    assert len(catalog.lookup("  МОСКВА,  дом 1  ")) == 2
    assert catalog.lookup("Missing address") == []
