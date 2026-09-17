"""Second-region and simultaneous multi-zone Router acceptance tests."""

import hashlib
import json
import shutil
from pathlib import Path

import pytest
from core.contracts import Policy
from core.engine import SearchSettings, solve
from core.geo import GraphTravel, configure_travel
from core.official import (
    OfficialScenarioConfig,
    combine_official_scenarios,
    load_official_region,
)
from core.prepare_official import prepare_official_fixture
from core.schedule import validate_plan

ROOT = Path(__file__).resolve().parents[2]
DATASET = ROOT / "data/dataset/anonymized"
GOLDEN = json.loads(
    (ROOT / "core/tests/golden/official-south-central-v1.json").read_text(encoding="utf-8")
)
NORMATIVE_SERVICE_SEC = {
    **dict.fromkeys(
        {"Конвергенция абонента", "Заявка на подключение", "Переключение на Гбит/с"},
        4200,
    ),
    **dict.fromkeys(
        {
            "Авария",
            "Нет линка",
            "Разрывы",
            "Низкая скорость",
            "Рост ошибок на порту",
            "IP-адрес 169...",
        },
        4800,
    ),
    **dict.fromkeys(
        {
            "Заказ подключения/Дозаказ оборудования",
            "Дозаказ оборудования",
            "Роутер. Замена техническим специалистом",
            "TVE/ENT. Замена приставки техником",
            "ТВ. Замена приставки техником",
        },
        1200,
    ),
    **dict.fromkeys(
        {"Работа с кабелем", "Мониторинг", "TVE/ENT. Другие ошибки", "Информация"},
        1800,
    ),
}


def _plan_hash(plan) -> str:
    return hashlib.sha256(plan.model_dump_json().encode("utf-8")).hexdigest()


def test_official_config_requires_all_source_and_resource_hashes():
    """No official acceptance scenario may silently opt out of provenance checks."""
    config = json.loads(
        (ROOT / "core/scenarios/south-central-v1/config.json").read_text(encoding="utf-8")
    )
    del config["resource_sha256"]["road_matrix"]
    with pytest.raises(ValueError, match="resource hashes must cover"):
        OfficialScenarioConfig.model_validate(config)


def test_all_official_work_types_use_normative_on_site_duration_only():
    """Scenario service time excludes the separately modelled road component."""
    observed = set()
    for region in ("east-v1", "south-central-v1", "southeast-v1"):
        config = json.loads(
            (ROOT / "core/scenarios" / region / "config.json").read_text(encoding="utf-8")
        )
        for work_type, duration_sec in config["duration_sec_by_hd_type"].items():
            observed.add(work_type)
            assert duration_sec == NORMATIVE_SERVICE_SEC[work_type]
    assert observed == set(NORMATIVE_SERVICE_SEC)


def test_official_import_emits_regions_and_optional_lunch_window():
    """Every official pool carries isolation and the agreed 45-minute lunch input."""
    for region in ("east", "southeast", "south_central"):
        scenario = load_official_region(DATASET, region)
        assert {request.region for request in scenario.snapshot.requests} == {region}
        assert {engineer.region for engineer in scenario.snapshot.engineers} == {region}
        for engineer in scenario.snapshot.engineers:
            assert engineer.lunch.enabled and not engineer.lunch.required
            assert engineer.lunch.duration_sec == 45 * 60
            assert (
                engineer.lunch.window_end_at - engineer.lunch.window_start_at == 3 * 3600 + 40 * 60
            )


def test_south_central_official_golden():
    """Run the second official region through the same strict importer and Engine."""
    scenario = load_official_region(DATASET, "south_central")
    settings = SearchSettings(**GOLDEN["settings"])
    travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
    )
    output = solve(
        scenario.snapshot,
        travel,
        settings,
    )
    validate_plan(output.memory.snapshot, output.main, travel)
    assert len(scenario.snapshot.requests) == GOLDEN["source"]["requests"]
    assert len(scenario.snapshot.engineers) == GOLDEN["source"]["engineers"]
    assert sum(request.priority == "urgent" for request in scenario.snapshot.requests) == 16
    assert scenario.geocode_quality == {"district_centroid_projection": 56}
    assert _plan_hash(output.baseline) == GOLDEN["baseline"]["plan_sha256"]
    assert _plan_hash(output.main) == GOLDEN["main"]["plan_sha256"]
    assert output.main.summary.assigned_count == GOLDEN["main"]["assigned_count"]
    assert output.main.summary.urgent_assigned_count == GOLDEN["main"]["urgent_assigned_count"]
    assert output.main.summary.travel_time_sec == GOLDEN["main"]["travel_time_sec"]
    assert [
        assignment.request_id
        for assignment in output.main.assignments
        if assignment.status == "unassigned"
    ] == GOLDEN["main"]["unassigned_request_ids"]


def test_southeast_official_region_is_complete_and_solvable():
    """Load the third organizer dataset with strict provenance and solve it offline."""
    scenario = load_official_region(DATASET, "southeast")
    assert len(scenario.snapshot.requests) == 83
    assert len(scenario.snapshot.engineers) == 12
    assert len(scenario.graph.nodes) == 76
    assert len(scenario.graph.edges) == 5700
    assert sum(request.priority == "urgent" for request in scenario.snapshot.requests) == 31
    assert scenario.geocode_quality == {"district_centroid_projection": 83}
    assert scenario.snapshot.policy.policy_id == "compact"

    settings = SearchSettings(time_limit_ms=3000, solution_limit=8)
    travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
    )
    output = solve(
        scenario.snapshot,
        travel,
        settings,
    )
    validate_plan(output.memory.snapshot, output.main, travel)
    assert output.main.is_usable
    # A bounded deterministic run may legitimately keep the feasible baseline when the
    # local-search budget expires before it finds an improving assignment.
    assert output.main.summary.assigned_count >= output.baseline.summary.assigned_count


def test_southeast_resources_regenerate_to_checked_hashes(tmp_path):
    """The third-region bundle must be reproducible from the pinned organizer CSVs."""
    scenario_dir = tmp_path / "southeast-v1"
    scenario_dir.mkdir()
    source_config = ROOT / "core/scenarios/southeast-v1/config.json"
    shutil.copy2(source_config, scenario_dir / "config.json")

    prepare_official_fixture(DATASET, scenario_dir)

    config = OfficialScenarioConfig.model_validate_json(source_config.read_bytes())
    assert (
        hashlib.sha256((scenario_dir / "geocodes.json").read_bytes()).hexdigest()
        == (config.resource_sha256["geocodes"])
    )
    assert (
        hashlib.sha256((scenario_dir / "road-matrix.json").read_bytes()).hexdigest()
        == (config.resource_sha256["road_matrix"])
    )


def test_east_and_south_central_run_as_one_isolated_multizone_problem():
    """Solve two official pools at once and prove no cross-zone assignment exists."""
    east = load_official_region(DATASET, "east")
    south = load_official_region(DATASET, "south_central")
    scenario = combine_official_scenarios([east, south])
    assert len(scenario.snapshot.requests) == 122
    assert len(scenario.snapshot.engineers) == 23
    assert len(scenario.graph.nodes) == 122
    assert len(scenario.graph.edges) == 7370

    settings = SearchSettings(time_limit_ms=8000, solution_limit=16)
    travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
    )
    assert (
        travel.quote(
            east.snapshot.engineers[0].start_location,
            south.snapshot.requests[0].location,
            "car",
        )
        is None
    )
    output = solve(
        scenario.snapshot,
        travel,
        settings,
    )
    validate_plan(output.memory.snapshot, output.main, travel)
    assert output.main.summary.requests_total == 122
    assert output.main.summary.assigned_count > output.baseline.summary.assigned_count
    assert all(
        assignment.status == "unassigned"
        or assignment.request_id.split(":", 1)[0] == assignment.engineer_id.split(":", 1)[0]
        for assignment in output.main.assignments
    )


def test_all_three_official_regions_run_as_one_isolated_problem():
    """Run every official row in one calculation while preserving zone isolation."""
    regions = [
        load_official_region(DATASET, region) for region in ("east", "southeast", "south_central")
    ]
    scenario = combine_official_scenarios(regions)
    assert scenario.zones == ("east", "southeast", "south_central")
    assert len(scenario.snapshot.requests) == 205
    assert len(scenario.snapshot.engineers) == 35
    assert len(scenario.graph.nodes) == 198
    assert len(scenario.graph.edges) == 13070

    settings = SearchSettings(time_limit_ms=8000, solution_limit=16)
    travel = configure_travel(
        GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
    )
    output = solve(
        scenario.snapshot,
        travel,
        settings,
    )
    validate_plan(output.memory.snapshot, output.main, travel)
    assert output.main.summary.requests_total == 205
    assert output.main.summary.assigned_count >= output.baseline.summary.assigned_count
    assert all(
        assignment.status == "unassigned"
        or assignment.request_id.split(":", 1)[0] == assignment.engineer_id.split(":", 1)[0]
        for assignment in output.main.assignments
    )


def test_every_v2_policy_builds_a_valid_second_region_plan():
    """Exercise every preset on organizer rows, not only synthetic unit fixtures."""
    scenario = load_official_region(DATASET, "south_central")
    for policy_id in ("fast", "compact", "sla", "balanced", "eco"):
        settings = SearchSettings(time_limit_ms=1200, solution_limit=6)
        travel = configure_travel(
            GraphTravel(scenario.graph), settings.technical(), scenario.snapshot.planning_as_of
        )
        snapshot = scenario.snapshot.model_copy(
            update={"policy": Policy(policy_id=policy_id, parameters={})}
        )
        output = solve(
            snapshot,
            travel,
            settings,
        )
        validate_plan(output.memory.snapshot, output.main, travel)
        assert output.main.is_usable
        assert output.main.summary.assigned_count > output.baseline.summary.assigned_count
