"""Strict offline import and multi-zone composition for official regional CSV data."""

from __future__ import annotations

import csv
import hashlib
import json
import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time
from pathlib import Path
from typing import Annotated, Literal, Self
from zoneinfo import ZoneInfo

from pydantic import Field, model_validator

from core.contracts import GeoPoint, Record, RouterTaskSnapshot, Skill, Transport
from core.geo import GraphEdge, GraphNode, RoadGraph


class TeamProfileSpec(Record):
    """Synthetic operational fields for one named team missing from the archive."""

    control_team: Annotated[str, Field(min_length=1)]
    transport_type: Transport
    shift_start: Annotated[str, Field(pattern=r"^\d{2}:\d{2}$")]
    shift_end: Annotated[str, Field(pattern=r"^\d{2}:\d{2}$")]


class TransportCostSpec(Record):
    """Explicit approximations used when the cached matrix has only car ETA."""

    car: Literal["osrm_duration"]
    bike_speed_kmh: Annotated[float, Field(gt=0)]
    walk_speed_kmh: Annotated[float, Field(gt=0)]
    transit_speed_kmh: Annotated[float, Field(gt=0)]
    transit_access_sec: Annotated[int, Field(ge=0)]


Region = Literal["east", "southeast", "south_central"]


class OfficialScenarioConfig(Record):
    """Versioned assumptions needed to turn organizer rows into a strict snapshot."""

    schema_version: Literal["1.0"]
    scenario_id: Annotated[str, Field(min_length=1)]
    region: Region
    local_date: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]
    timezone: Annotated[str, Field(min_length=1)]
    horizon_start: Annotated[str, Field(pattern=r"^\d{2}:\d{2}$")]
    horizon_end: Annotated[str, Field(pattern=r"^\d{2}:\d{2}$")]
    synthetic_file: Annotated[str, Field(min_length=1)]
    control_file: Annotated[str, Field(min_length=1)]
    expected_request_count: Annotated[int, Field(gt=0)]
    expected_team_count: Annotated[int, Field(gt=0)]
    priority_urgent_hd_types: list[str]
    duration_sec_by_hd_type: dict[str, Annotated[int, Field(gt=0)]]
    skill_by_hd_type: dict[str, Skill]
    team_profiles: list[TeamProfileSpec]
    transport_cost_model: TransportCostSpec
    assumptions: list[Annotated[str, Field(min_length=1)]]
    source_sha256: dict[Literal["synthetic", "control"], str] = Field(default_factory=dict)
    resource_sha256: dict[Literal["geocodes", "road_matrix"], str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def check_catalogs(self) -> Self:
        """Reject incomplete type catalogs, duplicate teams and reversed horizons."""
        if set(self.duration_sec_by_hd_type) != set(self.skill_by_hd_type):
            raise ValueError("duration and skill catalogs must cover the same HD types")
        teams = [profile.control_team for profile in self.team_profiles]
        if len(teams) != len(set(teams)) or len(teams) != self.expected_team_count:
            raise ValueError("team profile count or identity mismatch")
        if _clock(self.horizon_end) <= _clock(self.horizon_start):
            raise ValueError("scenario horizon is reversed")
        for catalog in (self.source_sha256, self.resource_sha256):
            if any(
                len(digest) != 64
                or any(character not in "0123456789abcdef" for character in digest)
                for digest in catalog.values()
            ):
                raise ValueError("scenario hashes must be lowercase SHA-256")
        if set(self.source_sha256) != {"synthetic", "control"}:
            raise ValueError("source hashes must cover synthetic and control files")
        if set(self.resource_sha256) != {"geocodes", "road_matrix"}:
            raise ValueError("resource hashes must cover geocodes and road matrix")
        return self


@dataclass(frozen=True)
class OfficialScenario:
    """Prepared regional snapshot, road graph and import provenance for benchmarks."""

    config: OfficialScenarioConfig
    snapshot: RouterTaskSnapshot
    graph: RoadGraph
    request_details: dict[str, dict[str, str | int | float | bool | None]]
    engineer_details: dict[str, dict[str, str | int | list[str]]]
    geocode_quality: dict[str, int]


@dataclass(frozen=True)
class MultiZoneScenario:
    """One strict calculation assembled from isolated official-region components."""

    scenario_id: str
    zones: tuple[str, ...]
    snapshot: RouterTaskSnapshot
    graph: RoadGraph
    request_details: dict[str, dict[str, str | int | float | bool | None]]
    engineer_details: dict[str, dict[str, str | int | list[str]]]
    geocode_quality: dict[str, int]
    assumptions: list[str]


OfficialEastScenario = OfficialScenario


def _clock(value: str) -> time:
    return datetime.strptime(value, "%H:%M").time()


def _epoch(local_day: date, local_clock: str, zone: ZoneInfo) -> int:
    moment = datetime.combine(local_day, _clock(local_clock), tzinfo=zone)
    return int(moment.timestamp())


def _read_rows(path: Path, extra_fields: set[str] | None = None) -> list[dict[str, str]]:
    """Decode organizer CSV and verify all columns needed by the selected stage."""
    with path.open(encoding="cp1251", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        required = {
            "Заявка",
            "Тип заявки BK",
            "Тип заявки HD",
            "Начало",
            "Окончание",
            "Район",
            "Адрес",
        }
        required.update(extra_fields or set())
        if reader.fieldnames is None or not required.issubset(reader.fieldnames):
            raise ValueError(f"official CSV headers are incomplete: {path.name}")
        return list(reader)


def _verify_file_hash(path: Path, expected: str | None) -> None:
    """Reject scenario source/resource drift before decoding or enrichment."""
    if expected is None:
        return
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError(f"official scenario file hash mismatch: {path.name}")


def _validate_request_rows(requests: list[dict[str, str]], control: list[dict[str, str]]) -> None:
    request_ids = [row["Заявка"] for row in requests]
    if len(request_ids) != len(set(request_ids)):
        raise ValueError("duplicate request ID in official synthetic CSV")
    fields = ("Начало", "Окончание", "Тип заявки HD", "Район")
    request_facts = Counter(tuple(row[field] for field in fields) for row in requests)
    control_facts = Counter(tuple(row[field] for field in fields) for row in control)
    if request_facts != control_facts:
        raise ValueError("official control rows do not match synthetic request facts")


def _load_geocodes(path: Path) -> tuple[dict[str, tuple[str, GeoPoint, str]], dict[str, GeoPoint]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    addresses: dict[str, tuple[str, GeoPoint, str]] = {}
    nodes: dict[str, GeoPoint] = {}
    for raw in payload["entries"]:
        address = raw["address"]
        if address in addresses:
            raise ValueError(f"duplicate geocode address: {address}")
        point = GeoPoint.model_validate(raw["location"])
        node_id = raw["node_id"]
        quality = raw["match_level"]
        addresses[address] = (node_id, point, quality)
        previous = nodes.setdefault(node_id, point)
        if previous != point:
            raise ValueError(f"geocode node coordinate mismatch: {node_id}")
    return addresses, nodes


def _profile_duration(distance_m: float, speed_kmh: float) -> int:
    return max(1, math.ceil(distance_m / (speed_kmh * 1000 / 3600)))


def _load_graph(path: Path, locations: dict[str, GeoPoint], costs: TransportCostSpec) -> RoadGraph:
    payload = json.loads(path.read_text(encoding="utf-8"))
    node_ids = payload["node_ids"]
    durations = payload["durations_sec"]
    distances = payload["distances_m"]
    if (
        len(node_ids) != len(locations)
        or set(node_ids) != set(locations)
        or len(durations) != len(node_ids)
        or len(distances) != len(node_ids)
        or any(len(row) != len(node_ids) for row in durations + distances)
    ):
        raise ValueError("road matrix shape or node identities mismatch")
    edges = []
    for source, source_id in enumerate(node_ids):
        for target, target_id in enumerate(node_ids):
            if source == target:
                continue
            distance = distances[source][target]
            car = durations[source][target]
            if distance is None or car is None:
                continue
            metres = math.ceil(distance)
            edges.append(
                GraphEdge(
                    source=source_id,
                    target=target_id,
                    distance_m=metres,
                    duration_sec={
                        "car": math.ceil(car),
                        "bike": _profile_duration(distance, costs.bike_speed_kmh),
                        "walk": _profile_duration(distance, costs.walk_speed_kmh),
                        "transit": costs.transit_access_sec
                        + _profile_duration(distance, costs.transit_speed_kmh),
                    },
                )
            )
    return RoadGraph(
        version=payload["version"],
        source=(
            f"{payload['source']} Bike/walk/transit use the explicit approximations "
            "from the official scenario config."
        ),
        nodes=[GraphNode(node_id=node_id, location=locations[node_id]) for node_id in node_ids],
        edges=edges,
    )


def load_official_region(
    dataset_dir: Path,
    region: Region,
    scenario_dir: Path | None = None,
) -> OfficialScenario:
    """Build one deterministic official-region benchmark from cached resources.

    Args:
        dataset_dir: Directory containing the organizer's anonymized CSV files.
        region: Official region key.
        scenario_dir: Versioned assumptions/geocodes/matrix directory. Defaults to
            ``core/scenarios/<region>-v1``.

    Returns:
        A strict Router snapshot, multi-profile graph and source metadata.

    Raises:
        ValueError: If the archive or resource catalogs drift or are incomplete.
    """
    scenario_dir = scenario_dir or Path(__file__).with_name("scenarios") / (
        f"{region.replace('_', '-')}-v1"
    )
    config = OfficialScenarioConfig.model_validate_json((scenario_dir / "config.json").read_bytes())
    if config.region != region:
        raise ValueError("scenario directory region does not match requested region")
    synthetic_path = dataset_dir / config.synthetic_file
    control_path = dataset_dir / config.control_file
    geocodes_path = scenario_dir / "geocodes.json"
    matrix_path = scenario_dir / "road-matrix.json"
    _verify_file_hash(synthetic_path, config.source_sha256["synthetic"])
    _verify_file_hash(control_path, config.source_sha256["control"])
    _verify_file_hash(geocodes_path, config.resource_sha256["geocodes"])
    _verify_file_hash(matrix_path, config.resource_sha256["road_matrix"])
    synthetic_raw = _read_rows(synthetic_path)
    control = [row for row in _read_rows(control_path, {"Бригада"}) if row["Заявка"].isdigit()]
    requests = [row for row in synthetic_raw if row["Заявка"].isdigit()]
    office_rows = [
        row for row in synthetic_raw if row["Заявка"].strip().casefold() == "адрес офиса"
    ]
    if len(requests) != config.expected_request_count or len(control) != len(requests):
        raise ValueError(f"official {region} request count drift")
    _validate_request_rows(requests, control)
    if len(office_rows) != 1:
        raise ValueError(f"official {region} office footer missing or duplicated")
    office_address = office_rows[0]["Тип заявки BK"]

    geocodes, locations = _load_geocodes(geocodes_path)
    required_addresses = {row["Адрес"] for row in requests} | {office_address}
    missing_addresses = required_addresses - set(geocodes)
    if missing_addresses:
        raise ValueError(f"geocode catalog misses {sorted(missing_addresses)!r}")
    graph = _load_graph(matrix_path, locations, config.transport_cost_model)

    profile_by_name = {profile.control_team: profile for profile in config.team_profiles}
    skills_by_team: dict[str, set[Skill]] = defaultdict(set)
    for row in control:
        team = row["Бригада"].strip()
        if not team:
            continue
        work_type = row["Тип заявки HD"]
        if work_type not in config.skill_by_hd_type:
            raise ValueError(f"unknown control HD type: {work_type}")
        skills_by_team[team].add(config.skill_by_hd_type[work_type])
    team_order = [profile.control_team for profile in config.team_profiles]
    if set(skills_by_team) != set(profile_by_name) or len(team_order) != config.expected_team_count:
        raise ValueError("control team identities drifted from scenario profiles")

    local_day = date.fromisoformat(config.local_date)
    zone = ZoneInfo(config.timezone)
    office = geocodes[office_address][1]
    skill_order = {"local": 0, "connection": 1, "emergency": 2}
    engineers = []
    engineer_details: dict[str, dict[str, str | int | list[str]]] = {}
    for index, team in enumerate(team_order):
        profile = profile_by_name[team]
        engineer_id = f"{region}-team-{index + 1:02d}"
        skills = sorted(skills_by_team[team], key=skill_order.__getitem__)
        engineers.append(
            {
                "engineer_id": engineer_id,
                "input_order": index,
                "skills": skills,
                "transport_type": profile.transport_type,
                "shift_start_at": _epoch(local_day, profile.shift_start, zone),
                "shift_end_at": _epoch(local_day, profile.shift_end, zone),
                "start_location": office.model_dump(),
                "available_from": _epoch(local_day, profile.shift_start, zone),
                "position_observed_at": None,
                "availability": "online",
                "expected_online_at": None,
                "lunch_taken": False,
                "lunch": {
                    "enabled": False,
                    "duration_sec": None,
                    "window_start_at": None,
                    "window_end_at": None,
                    "required": False,
                },
            }
        )
        engineer_details[engineer_id] = {
            "control_team": team,
            "skills": skills,
            "transport_type": profile.transport_type,
            "shift_start": profile.shift_start,
            "shift_end": profile.shift_end,
        }

    request_payloads = []
    request_details: dict[str, dict[str, str | int | float | bool | None]] = {}
    quality: dict[str, int] = defaultdict(int)
    for arrival_order, row in enumerate(requests):
        request_id = row["Заявка"]
        work_type = row["Тип заявки HD"]
        if work_type not in config.duration_sec_by_hd_type:
            raise ValueError(f"unknown request HD type: {work_type}")
        _node_id, point, match_level = geocodes[row["Адрес"]]
        quality[match_level] += 1
        window_start = int(
            datetime.strptime(row["Начало"], "%d.%m.%Y %H:%M").replace(tzinfo=zone).timestamp()
        )
        window_end = int(
            datetime.strptime(row["Окончание"], "%d.%m.%Y %H:%M").replace(tzinfo=zone).timestamp()
        )
        priority = "urgent" if work_type in config.priority_urgent_hd_types else "normal"
        skill = config.skill_by_hd_type[work_type]
        duration = config.duration_sec_by_hd_type[work_type]
        request_payloads.append(
            {
                "request_id": request_id,
                "arrival_order": arrival_order,
                "location": point.model_dump(),
                "service_duration_sec": duration,
                "window_start_at": window_start,
                "window_end_at": window_end,
                "priority": priority,
                "required_skill": skill,
                "required_transport": None,
            }
        )
        request_details[request_id] = {
            "work_type": work_type,
            "district": row["Район"],
            "address": row["Адрес"],
            "geocode_match_level": match_level,
            "priority": priority,
            "required_skill": skill,
            "service_duration_sec": duration,
        }

    snapshot = RouterTaskSnapshot.model_validate(
        {
            "schema_version": "1.0",
            "planning_as_of": _epoch(local_day, config.horizon_start, zone),
            "horizon_start_at": _epoch(local_day, config.horizon_start, zone),
            "horizon_end_at": _epoch(local_day, config.horizon_end, zone),
            "requests": request_payloads,
            "engineers": engineers,
            "policy": {"policy_id": "fast", "parameters": {}},
        }
    )
    return OfficialScenario(
        config=config,
        snapshot=snapshot,
        graph=graph,
        request_details=request_details,
        engineer_details=engineer_details,
        geocode_quality=dict(quality),
    )


def load_official_east(dataset_dir: Path, scenario_dir: Path | None = None) -> OfficialScenario:
    """Keep the established East loader as a compatibility wrapper."""
    return load_official_region(dataset_dir, "east", scenario_dir)


def combine_official_scenarios(
    scenarios: list[OfficialScenario],
) -> MultiZoneScenario:
    """Combine isolated regional graphs into one multi-zone Engine calculation.

    Regions remain disconnected by construction. Namespaced business and graph IDs
    prevent collisions, while contiguous order fields preserve baseline semantics.
    """
    if len(scenarios) < 2:
        raise ValueError("multi-zone scenario requires at least two regions")
    zones = tuple(scenario.config.region for scenario in scenarios)
    if len(set(zones)) != len(zones):
        raise ValueError("multi-zone scenario contains a duplicate region")
    first = scenarios[0].snapshot
    for scenario in scenarios[1:]:
        if (
            scenario.snapshot.horizon_start_at != first.horizon_start_at
            or scenario.snapshot.horizon_end_at != first.horizon_end_at
            or scenario.snapshot.policy != first.policy
        ):
            raise ValueError("multi-zone horizons and policies must match")

    requests = []
    engineers = []
    nodes = []
    edges = []
    request_details = {}
    engineer_details = {}
    quality: Counter[str] = Counter()
    for scenario in scenarios:
        zone = scenario.config.region
        request_offset = len(requests)
        engineer_offset = len(engineers)
        for index, request in enumerate(scenario.snapshot.requests):
            request_id = f"{zone}:{request.request_id}"
            requests.append(
                request.model_copy(
                    update={"request_id": request_id, "arrival_order": request_offset + index}
                )
            )
            request_details[request_id] = {
                **scenario.request_details[request.request_id],
                "zone": zone,
            }
        for index, engineer in enumerate(scenario.snapshot.engineers):
            engineer_id = f"{zone}:{engineer.engineer_id}"
            engineers.append(
                engineer.model_copy(
                    update={"engineer_id": engineer_id, "input_order": engineer_offset + index}
                )
            )
            engineer_details[engineer_id] = {
                **scenario.engineer_details[engineer.engineer_id],
                "zone": zone,
            }
        nodes.extend(
            node.model_copy(update={"node_id": f"{zone}:{node.node_id}"})
            for node in scenario.graph.nodes
        )
        edges.extend(
            edge.model_copy(
                update={"source": f"{zone}:{edge.source}", "target": f"{zone}:{edge.target}"}
            )
            for edge in scenario.graph.edges
        )
        quality.update(scenario.geocode_quality)

    snapshot = RouterTaskSnapshot(
        schema_version="1.0",
        planning_as_of=first.planning_as_of,
        horizon_start_at=first.horizon_start_at,
        horizon_end_at=first.horizon_end_at,
        requests=requests,
        engineers=engineers,
        policy=first.policy,
    )
    graph = RoadGraph(
        version="multi-zone:" + "+".join(scenario.graph.version for scenario in scenarios),
        source="Disconnected union of prepared official-region graph resources.",
        nodes=nodes,
        edges=edges,
    )
    return MultiZoneScenario(
        scenario_id="official-" + "+".join(zones) + "-v2",
        zones=zones,
        snapshot=snapshot,
        graph=graph,
        request_details=request_details,
        engineer_details=engineer_details,
        geocode_quality=dict(quality),
        assumptions=[
            "Each region is an isolated graph component; cross-zone assignments are unreachable.",
            "Business and graph IDs are namespaced by region for this combined calculation.",
        ],
    )
