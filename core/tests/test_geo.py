"""Road direction, fallback, traffic context and address ambiguity."""

from datetime import datetime
from zoneinfo import ZoneInfo

from core.contracts import GeoPoint, RouterTechnicalSettings
from core.geo import (
    AddressCandidate,
    Gazetteer,
    GraphTravel,
    RoadGraph,
    configure_forecast_traffic,
    configure_travel,
    forecast_traffic_factor,
    quote_at,
    routing_context_version,
)
from core.schedule import baseline


def test_path_matrix_and_profiles(graph):
    travel = GraphTravel(graph)
    a, b = graph.nodes[0].location, graph.nodes[3].location
    route = travel.quote(a, b, "car")
    assert (route.duration_sec, route.distance_m) == (180, 1800)
    assert route.provenance == "road_matrix"
    assert route.points == tuple(n.location for n in graph.nodes)
    assert route.geometry_exact is False
    assert travel.quote(a, b, "walk").duration_sec == 1260
    assert travel.matrix([a, b], "car")[0][1] == route


def test_direction_unreachable_and_unknown_coordinates(graph):
    data = graph.model_dump()
    data["edges"] = [e for e in data["edges"] if int(e["source"]) < int(e["target"])]
    travel = GraphTravel(RoadGraph.model_validate(data))
    assert travel.quote(graph.nodes[3].location, graph.nodes[0].location, "car") is None
    fallback = travel.quote(GeoPoint(lat=0, lon=0), graph.nodes[0].location, "car")
    assert fallback is not None and fallback.provenance == "approximate"
    assert fallback.duration_sec > 0 and fallback.distance_m > 0
    assert travel.nearest(graph.nodes[0].location, 0)[0] == "0"


def test_traffic_matrix_does_not_claim_route_geometry(snapshot, graph):
    """A traffic ETA matrix has exact costs, but no provider route polyline."""
    traffic_graph = graph.model_copy(update={"version": "2gis:test-matrix"}, deep=True)
    plan = baseline(snapshot, GraphTravel(traffic_graph))
    assert plan.routes[0].legs
    assert all(leg.travel_source == "traffic_api" for leg in plan.routes[0].legs)
    assert all(leg.geometry is None for leg in plan.routes[0].legs)


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
    fixed = configure_travel(raw, RouterTechnicalSettings(travel_time_mode="fixed_normative"))

    assert buffered.quote(a, b, "car").duration_sec == original.duration_sec + 600
    assert fixed.quote(a, b, "car").duration_sec == 1200
    assert buffered.quote(a, b, "car").distance_m == original.distance_m
    assert fixed.quote(a, b, "car").points == original.points
    assert buffered.quote(a, b, "car").provenance == "road_matrix"
    assert fixed.quote(a, b, "car").provenance == "approximate"
    assert buffered.quote(a, a, "car").duration_sec == 0
    assert fixed.quote(a, a, "car").duration_sec == 0


def test_forecast_traffic_is_versioned_directional_and_uses_planning_time_proxy(graph):
    """V1 changes ETA deterministically while preserving its road-matrix source."""
    zone = ZoneInfo("Europe/Moscow")
    morning = int(datetime(2026, 8, 17, 8, 0, tzinfo=zone).timestamp())
    later_same_period = morning + 20 * 60
    evening = int(datetime(2026, 8, 17, 18, 0, tzinfo=zone).timestamp())
    center = GeoPoint(lat=55.7558, lon=37.6173)
    outer = GeoPoint(lat=55.90, lon=37.6173)

    assert forecast_traffic_factor(morning, outer, center) > forecast_traffic_factor(
        morning, center, outer
    )
    first = configure_forecast_traffic(GraphTravel(graph), morning)
    same_band = configure_forecast_traffic(first, later_same_period)
    changed_band = configure_forecast_traffic(first, evening)
    assert first.version == same_band.version
    assert first.version != changed_band.version
    settings = RouterTechnicalSettings()
    assert routing_context_version(first, settings) == routing_context_version(
        changed_band, settings
    )

    quote = first.quote(graph.nodes[0].location, graph.nodes[1].location, "car")
    assert quote.provenance == "road_matrix"
    assert quote.traffic_factor > 1
    assert quote.duration_sec > 60

    daytime = int(datetime(2026, 8, 17, 13, 0, tzinfo=zone).timestamp())
    configured = configure_travel(GraphTravel(graph), settings, morning)
    morning_quote = quote_at(configured, outer, center, "car", morning)
    daytime_quote = quote_at(configured, outer, center, "car", daytime)
    evening_quote = quote_at(configured, outer, center, "car", evening)
    assert morning_quote.traffic_factor > daytime_quote.traffic_factor
    assert daytime_quote.traffic_factor != evening_quote.traffic_factor


def test_geocoder_preserves_ambiguity(graph):
    candidates = [
        AddressCandidate(address="Москва, Дом 1", location=n.location, source="test")
        for n in graph.nodes[:2]
    ]
    catalog = Gazetteer(candidates)
    assert len(catalog.lookup("  МОСКВА,  дом 1  ")) == 2
    assert catalog.lookup("Missing address") == []
