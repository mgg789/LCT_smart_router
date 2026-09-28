"""Offline metro selection, segment persistence and transport-policy regression tests."""

from core.contracts import GeoPoint, RouterTechnicalSettings
from core.geo import GraphTravel, RoadGraph, TravelQuote, configure_travel, routing_context_version
from core.metro import MetroNetwork, MetroTravel, choose_metro, configured_metro_travel
from core.schedule import baseline, eligible


def _network(*, disconnected: bool = False) -> MetroNetwork:
    """Build a deliberately tiny reviewed-style graph; production data is external."""
    edges = [] if disconnected else [
        {"source": "a", "target": "b", "duration_sec": 120, "distance_m": 1500},
        {"source": "b", "target": "a", "duration_sec": 120, "distance_m": 1500},
        {
            "source": "b",
            "target": "c",
            "duration_sec": 90,
            "distance_m": 800,
            "kind": "transfer",
        },
        {"source": "c", "target": "b", "duration_sec": 90, "distance_m": 800, "kind": "transfer"},
        {"source": "c", "target": "d", "duration_sec": 120, "distance_m": 1400},
        {"source": "d", "target": "c", "duration_sec": 120, "distance_m": 1400},
    ]
    return MetroNetwork.model_validate(
        {
            "version": "fixture-v1",
            "source": "test reviewed graph",
            "boundary_geojson": {"type": "MultiPolygon", "coordinates": [[[
                [37.50, 55.70], [37.80, 55.70], [37.80, 55.90], [37.50, 55.90],
            ]]]},
            "stations": [
                {"station_id": station, "name": station, "line_id": line, "location": point}
                for station, line, point in (
                    ("a", "1", {"lat": 55.750, "lon": 37.600}),
                    ("b", "1", {"lat": 55.755, "lon": 37.620}),
                    ("c", "2", {"lat": 55.755, "lon": 37.620}),
                    ("d", "2", {"lat": 55.760, "lon": 37.650}),
                )
            ],
            "edges": edges,
            "enter_sec": 180,
            "exit_sec": 120,
            "wait_sec": 120,
            "transfer_sec": 240,
        }
    )


class _WalkingTravel:
    """Deliberately slow pedestrian provider used to make selection observable."""

    version = "walking-fixture"

    def quote(self, origin, destination, profile):
        if origin == destination:
            return TravelQuote(0, 0, (origin, destination), "road_matrix")
        return TravelQuote(1_800, 5_000, (origin, destination), "road_matrix")


def test_metro_shortest_path_includes_transfer_and_composite_segments():
    origin = GeoPoint(lat=55.750, lon=37.600)
    destination = GeoPoint(lat=55.760, lon=37.650)
    quote = MetroTravel(_WalkingTravel(), _network()).quote(origin, destination, "transit")

    assert quote is not None
    assert quote.provenance == "metro"
    assert [segment.provenance for segment in quote.segments] == ["road_matrix", "metro", "road_matrix"]
    # enter + wait + ride + transfer penalty + ride + exit
    assert quote.segments[1].duration_sec == 180 + 120 + 120 + 90 + 240 + 120 + 120
    assert sum(segment.duration_sec for segment in quote.segments) == quote.duration_sec
    assert len(quote.segments[1].points) >= 2
    assert GeoPoint(lat=55.755, lon=37.620) in quote.segments[1].points
    assert MetroTravel(_WalkingTravel(), _network()).quote(origin, destination, "walk").provenance == "road_matrix"


def test_metro_is_not_used_when_disabled_outside_boundary_or_unreachable():
    origin = GeoPoint(lat=55.750, lon=37.600)
    destination = GeoPoint(lat=55.760, lon=37.650)
    walking = _WalkingTravel().quote(origin, destination, "walk")

    assert MetroTravel(_WalkingTravel(), _network()).quote(origin, GeoPoint(lat=56, lon=38), "transit") == _WalkingTravel().quote(origin, GeoPoint(lat=56, lon=38), "walk")
    assert MetroTravel(_WalkingTravel(), _network(disconnected=True)).quote(origin, destination, "transit") == walking
    # No configured artifact means the default false flag remains the base provider.
    configured = configure_travel(_WalkingTravel(), RouterTechnicalSettings(metro_enabled=False))
    assert configured.quote(origin, destination, "transit").provenance == "road_matrix"


def test_solver_persists_selected_metro_segments(snapshot):
    origin = GeoPoint(lat=55.750, lon=37.600)
    destination = GeoPoint(lat=55.760, lon=37.650)
    engineer = snapshot.engineers[0].model_copy(
        update={"transport_type": "transit", "start_location": origin}
    )
    request = snapshot.requests[0].model_copy(update={"location": destination})
    task = snapshot.model_copy(update={"engineers": [engineer], "requests": [request]})
    plan = baseline(task, MetroTravel(_WalkingTravel(), _network()))

    leg = plan.routes[0].legs[0]
    assert leg.travel_source == "metro"
    assert [segment.travel_source for segment in leg.segments] == ["road_matrix", "metro", "road_matrix"]


def test_explicit_walk_only_profile_excludes_transit_work_and_metro(snapshot):
    origin = GeoPoint(lat=55.750, lon=37.600)
    destination = GeoPoint(lat=55.760, lon=37.650)
    walk_only = snapshot.engineers[0].model_copy(
        update={
            "transport_type": "walk",
            "transit_eligible": False,
            "start_location": origin,
        }
    )
    transit_required = snapshot.requests[0].model_copy(
        update={"location": destination, "required_transport": "transit"}
    )
    task = snapshot.model_copy(update={"engineers": [walk_only], "requests": [transit_required]})

    assert not eligible(task, walk_only, transit_required)
    assert MetroTravel(_WalkingTravel(), _network()).quote(
        origin, destination, walk_only.travel_profile()
    ).provenance == "road_matrix"

    legacy_walk = walk_only.model_copy(update={"transit_eligible": True})
    assert eligible(task, legacy_walk, transit_required)
    assert MetroTravel(_WalkingTravel(), _network()).quote(
        origin, destination, legacy_walk.travel_profile()
    ).provenance == "metro"


def test_legacy_transit_is_pedestrian_and_microedge_policy_is_consistent():
    graph = RoadGraph.model_validate(
        {
            "version": "micro-v1",
            "source": "test",
            "nodes": [
                {"node_id": "a", "location": {"lat": 55.75, "lon": 37.60}},
                {"node_id": "b", "location": {"lat": 55.75, "lon": 37.602}},
            ],
            "edges": [
                {
                    "source": "a", "target": "b", "distance_m": 200,
                    "duration_sec": {"car": 4, "walk": 120, "bike": 180, "transit": 20},
                }
            ],
        }
    )
    travel = GraphTravel(graph)
    a, b = (node.location for node in graph.nodes)
    assert travel.quote(a, b, "transit").duration_sec == travel.quote(a, b, "walk").duration_sec
    assert travel.quote(a, b, "car").duration_sec == travel.quote(a, b, "walk").duration_sec
    assert travel.quote(a, b, "bike").duration_sec < travel.quote(a, b, "walk").duration_sec
    assert routing_context_version(travel, RouterTechnicalSettings()) != routing_context_version(
        travel, RouterTechnicalSettings(metro_enabled=True)
    )


def test_metro_compares_all_accessible_stations_and_joins_real_segment_geometry():
    """A farther station can win when its complete metro path is faster."""
    origin = GeoPoint(lat=55.750, lon=37.600)
    destination = GeoPoint(lat=55.760, lon=37.650)
    network = MetroNetwork.model_validate(
        {
            "version": "choice-v1", "source": "test", "enter_sec": 0, "exit_sec": 0,
            "wait_sec": 0, "transfer_sec": 0,
            "boundary_geojson": {"type": "MultiPolygon", "coordinates": [[[
                [37.50, 55.70], [37.80, 55.70], [37.80, 55.90], [37.50, 55.90],
            ]]]},
            "stations": [
                {"station_id": "near", "name": "near", "location": origin.model_dump()},
                {"station_id": "far", "name": "far", "location": {"lat": 55.750, "lon": 37.605}},
                {"station_id": "target", "name": "target", "location": destination.model_dump()},
            ],
            "edges": [
                {"source": "near", "target": "target", "duration_sec": 2000, "distance_m": 3000},
                {"source": "far", "target": "target", "duration_sec": 100, "distance_m": 2500},
            ],
        }
    )

    class CostedWalk:
        version = "choice-walk"

        def quote(self, start, end, profile):
            if start == end:
                return TravelQuote(0, 0, (start, end), "road_matrix")
            if end.lon == 37.605:
                return TravelQuote(100, 400, (start, GeoPoint(lat=55.751, lon=37.603), end), "road_matrix")
            if start.lon == 37.605:
                return TravelQuote(10_000, 1, (start, end), "road_matrix")
            if start == origin and end == destination:
                return TravelQuote(10_000, 5_000, (start, end), "road_matrix")
            return TravelQuote(10, 100, (start, end), "road_matrix")

    quote = MetroTravel(CostedWalk(), network).quote(origin, destination, "transit")
    assert quote is not None and quote.provenance == "metro"
    assert quote.segments[1].points[0] == GeoPoint(lat=55.750, lon=37.605)
    assert quote.points == (
        origin,
        GeoPoint(lat=55.751, lon=37.603),
        GeoPoint(lat=55.750, lon=37.605),
        destination,
    )


def test_default_bundled_moscow_network_is_loaded_without_environment_override(monkeypatch):
    """The reviewed resource is the default; env remains an explicit deployment override."""
    monkeypatch.delenv("ROUTER_METRO_DATA_PATH", raising=False)
    travel = configured_metro_travel(_WalkingTravel())
    assert isinstance(travel, MetroTravel)
    assert travel.network.version == "moscow-osm-2026-09-22"
    assert len(travel.network.stations) >= 200


def test_storm_keeps_a_modest_metro_detour_and_clear_weather_does_not():
    assert choose_metro(100, 90, shelter=False) is True
    assert choose_metro(100, 150, shelter=False) is False
    assert choose_metro(100, 150, shelter=True) is True
    assert choose_metro(100, 176, shelter=True) is False
    assert choose_metro(100, None, shelter=True) is False


class _SnappedWalkingTravel:
    """Pedestrian provider whose geometry stops short of the platform, as a graph does.

    A real foot route ends on the nearest routable node, not on the station point the
    metro geometry starts from -- the case the segment join has to survive.
    """

    version = "snapped-walking-fixture"

    def quote(self, origin, destination, profile):
        if origin == destination:
            return TravelQuote(0, 0, (origin, destination), "road_matrix")
        snapped = GeoPoint(lat=destination.lat + 0.0004, lon=destination.lon - 0.0004)
        return TravelQuote(1_800, 5_000, (origin, snapped), "road_matrix")


def _reversed_geometry_network() -> MetroNetwork:
    """One ride whose stored line runs target-to-source, as half the real artifact does."""
    line = [{"lat": 55.750, "lon": 37.600}, {"lat": 55.752, "lon": 37.610}, {"lat": 55.755, "lon": 37.620}]
    return MetroNetwork.model_validate(
        {
            "version": "fixture-reversed",
            "source": "test reviewed graph",
            "boundary_geojson": {"type": "MultiPolygon", "coordinates": [[[
                [37.50, 55.70], [37.80, 55.70], [37.80, 55.90], [37.50, 55.90],
            ]]]},
            "stations": [
                {"station_id": "a", "name": "a", "line_id": "1", "location": {"lat": 55.750, "lon": 37.600}},
                {"station_id": "b", "name": "b", "line_id": "1", "location": {"lat": 55.755, "lon": 37.620}},
            ],
            "edges": [
                {"source": "a", "target": "b", "duration_sec": 120, "distance_m": 1500,
                 "geometry": [[point["lat"], point["lon"]] for point in line]},
                # Same physical track, stored without being turned round -- the defect.
                {"source": "b", "target": "a", "duration_sec": 120, "distance_m": 1500,
                 "geometry": [[point["lat"], point["lon"]] for point in line]},
            ],
            "enter_sec": 180,
            "exit_sec": 120,
            "wait_sec": 120,
            "transfer_sec": 240,
        }
    )


def test_ride_geometry_is_turned_to_face_its_own_direction():
    """A back-to-front stored line must not make the ride start at the wrong station."""
    network = _reversed_geometry_network()
    there = MetroTravel(_WalkingTravel(), network).quote(
        GeoPoint(lat=55.750, lon=37.600), GeoPoint(lat=55.755, lon=37.620), "transit"
    )
    back = MetroTravel(_WalkingTravel(), network).quote(
        GeoPoint(lat=55.755, lon=37.620), GeoPoint(lat=55.750, lon=37.600), "transit"
    )

    assert there is not None and back is not None
    assert there.segments[1].points[0] == GeoPoint(lat=55.750, lon=37.600)
    assert there.segments[1].points[-1] == GeoPoint(lat=55.755, lon=37.620)
    # The opposite direction reads the very same stored line and must run the other way.
    assert back.segments[1].points[0] == GeoPoint(lat=55.755, lon=37.620)
    assert back.segments[1].points[-1] == GeoPoint(lat=55.750, lon=37.600)


def test_composite_segments_join_at_their_endpoints():
    """The System Layer rejects a leg whose segments leave a gap (result.types.ts)."""
    quote = MetroTravel(_SnappedWalkingTravel(), _network()).quote(
        GeoPoint(lat=55.750, lon=37.600), GeoPoint(lat=55.760, lon=37.650), "transit"
    )

    assert quote is not None
    assert len(quote.segments) == 3
    for before, after in zip(quote.segments, quote.segments[1:]):
        assert before.points[-1] == after.points[0]
    # Stitching adds the connector only; the costs stay exactly what was quoted.
    assert sum(segment.duration_sec for segment in quote.segments) == quote.duration_sec
    assert sum(segment.distance_m for segment in quote.segments) == quote.distance_m
