"""Small explicit road network and v14 input, independent of legacy contracts."""

import json
from pathlib import Path

import pytest
from core.benchmark import run_official_benchmark, run_replanning_events
from core.contracts import RouterTaskSnapshot
from core.engine import SearchSettings
from core.geo import RoadGraph
from core.official import load_official_east

ROOT = Path(__file__).resolve().parents[2]
OFFICIAL_GOLDEN = json.loads(
    (ROOT / "core/tests/golden/official-east-v1.json").read_text(encoding="utf-8")
)


@pytest.fixture(scope="session")
def official_east_scenario():
    """Load the versioned official East scenario once for acceptance tests."""
    return load_official_east(ROOT / "data/dataset/anonymized")


@pytest.fixture(scope="session")
def official_east_run(official_east_scenario):
    """Run the deterministic official golden settings once per test session."""
    return run_official_benchmark(
        official_east_scenario,
        SearchSettings(**OFFICIAL_GOLDEN["settings"]),
    )


@pytest.fixture(scope="session")
def official_east_events(official_east_scenario, official_east_run):
    """Calculate all five independent replanning acceptance events once."""
    return run_replanning_events(
        official_east_scenario,
        official_east_run.output,
        SearchSettings(time_limit_ms=3000, solution_limit=32),
    )


@pytest.fixture
def graph():
    """Directed test network with return paths and distinct transport costs."""
    nodes = [
        {"node_id": str(i), "location": {"lat": 55.75, "lon": 37.60 + i * 0.01}} for i in range(4)
    ]
    edges = []
    for i in range(3):
        for a, b in ((i, i + 1), (i + 1, i)):
            edges.append(
                {
                    "source": str(a),
                    "target": str(b),
                    "distance_m": 600,
                    "duration_sec": {"car": 60, "walk": 420, "bike": 180, "transit": 300},
                }
            )
    return RoadGraph.model_validate(
        {"version": "fixture-1", "source": "synthetic test graph", "nodes": nodes, "edges": edges}
    )


@pytest.fixture
def snapshot(graph):
    """Epoch timestamps with one capable engineer and three sequential jobs."""
    start = 1786946400
    lunch = {
        "enabled": False,
        "duration_sec": None,
        "window_start_at": None,
        "window_end_at": None,
        "required": False,
    }
    engineer = {
        "engineer_id": "eng-1",
        "input_order": 0,
        "skills": ["local", "connection"],
        "transport_type": "car",
        "shift_start_at": start,
        "shift_end_at": start + 8 * 3600,
        "start_location": graph.nodes[0].location.model_dump(),
        "available_from": start,
        "position_observed_at": None,
        "availability": "online",
        "expected_online_at": None,
        "lunch_taken": False,
        "lunch": lunch,
    }
    requests = [
        {
            "request_id": f"job-{i}",
            "arrival_order": 3 - i,
            "location": graph.nodes[i].location.model_dump(),
            "service_duration_sec": 600,
            "window_start_at": start,
            "window_end_at": start + 7 * 3600,
            "priority": "normal",
            "required_skill": "local",
            "required_transport": None,
        }
        for i in range(1, 4)
    ]
    return RouterTaskSnapshot.model_validate(
        {
            "schema_version": "1.0",
            "planning_as_of": start,
            "horizon_start_at": start,
            "horizon_end_at": start + 8 * 3600,
            "engineers": [engineer],
            "requests": requests,
            "policy": {"policy_id": "fast", "parameters": {}},
        }
    )
