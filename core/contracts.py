"""Strict v14 JSON boundary; timestamps and durations are integer seconds."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

ID = Annotated[str, Field(min_length=1)]
Seconds = Annotated[int, Field(ge=0)]
PositiveSeconds = Annotated[int, Field(gt=0)]
Transport = Literal["car", "walk", "bike", "transit"]
Skill = Literal["local", "connection", "emergency"]
EquipmentType = Literal["router", "set_top_box", "smart_speaker"]
TravelTimeMode = Literal["graph_with_access_buffer", "fixed_normative"]
TravelProvenance = Literal["approximate", "road_matrix", "route_api", "traffic_api"]


class Record(BaseModel):
    """Reject unknown fields, coercion and non-finite numbers at every boundary."""

    model_config = ConfigDict(extra="forbid", strict=True, frozen=True, allow_inf_nan=False)


class GeoPoint(Record):
    """WGS84 geographic coordinates in degrees, never GeoJSON lon/lat arrays."""

    lat: Annotated[float, Field(ge=-90, le=90)]
    lon: Annotated[float, Field(ge=-180, le=180)]


class LunchInput(Record):
    """Normalized absolute lunch window supplied by sys, with no invented defaults."""

    enabled: bool
    duration_sec: PositiveSeconds | None
    window_start_at: Seconds | None
    window_end_at: Seconds | None
    required: bool


class EquipmentStock(Record):
    """Immutable start-of-day stock carried by one engineer; units never transfer."""

    router: int = Field(default=0, ge=0)
    set_top_box: int = Field(default=0, ge=0)
    smart_speaker: int = Field(default=0, ge=0)

    def quantity(self, equipment_type: EquipmentType) -> int:
        """Return carried units for one closed-catalog equipment type."""
        return getattr(self, equipment_type)


class Request(Record):
    """An unstarted job; its customer window constrains service start only."""

    request_id: ID
    arrival_order: Seconds
    location: GeoPoint
    service_duration_sec: PositiveSeconds
    window_start_at: Seconds
    window_end_at: Seconds
    priority: Literal["normal", "urgent"]
    required_skill: Skill
    required_transport: Transport | None
    required_equipment: EquipmentType | None = None
    region: Annotated[str, Field(min_length=1)] | None = None

    @model_validator(mode="after")
    def check_window(self) -> Self:
        """Reject reversed windows without silently repairing input."""
        if self.window_end_at < self.window_start_at:
            raise ValueError("request window is reversed")
        return self


class Engineer(Record):
    """Prepared continuation point and availability; execution facts belong to sys."""

    engineer_id: ID
    input_order: Seconds
    skills: list[Skill] = Field(min_length=1, max_length=3)
    transport_type: Transport
    shift_start_at: Seconds
    shift_end_at: Seconds
    start_location: GeoPoint
    available_from: Seconds | None
    availability: Literal["online", "offline"]
    expected_online_at: Seconds | None
    lunch_taken: bool
    lunch: LunchInput
    equipment_stock: EquipmentStock
    region: Annotated[str, Field(min_length=1)] | None = None

    @model_validator(mode="after")
    def check_conditions(self) -> Self:
        """Validate shift, unique skills and effective lunch configuration."""
        if self.shift_end_at <= self.shift_start_at or len(set(self.skills)) != len(self.skills):
            raise ValueError("invalid shift or duplicate skills")
        lunch = self.lunch
        if not self.lunch_taken:
            if lunch.required and not lunch.enabled:
                raise ValueError("required lunch must be enabled")
            if lunch.enabled:
                if any(
                    v is None
                    for v in (lunch.duration_sec, lunch.window_start_at, lunch.window_end_at)
                ):
                    raise ValueError("enabled lunch requires duration and both window boundaries")
                if lunch.window_end_at < lunch.window_start_at:
                    raise ValueError("lunch window is reversed")
        return self


class Policy(Record):
    """Supported catalog choice; preferences cannot disable hard constraints."""

    policy_id: Literal["fast", "compact", "sla", "balanced", "eco", "covering"]
    parameters: dict[str, str | int | float | bool | None]

    @model_validator(mode="after")
    def check_parameters(self) -> Self:
        """Reject unsupported preferences instead of pretending they were applied."""
        if self.parameters:
            raise ValueError(f"{self.policy_id} accepts only empty parameters")
        return self


class RouterTechnicalSettings(Record):
    """Persisted Router-owned controls that version the calculation context."""

    lunches_enabled: bool = False
    traffic_enabled: bool = True
    equipment_enabled: bool = True
    window_lateness_tolerance_sec: int = Field(default=0, ge=0, le=1200)
    departure_lateness_tolerance_sec: int = Field(default=0, ge=0, le=86400)
    task_start_lateness_tolerance_sec: int = Field(default=0, ge=0, le=86400)
    travel_time_mode: TravelTimeMode = "graph_with_access_buffer"
    access_buffer_sec: int = Field(default=600, ge=0, le=86400)
    fixed_travel_time_sec: int = Field(default=1200, gt=0, le=86400)
    early_finish_replan_threshold_sec: int = Field(default=900, ge=0, le=86400)
    task_overrun_tolerance_sec: int = Field(default=600, ge=0, le=86400)


class SnapshotPublicationEnvelope(Record):
    """Sys-owned active publication row before exact-byte verification by Router."""

    publication_id: ID
    publication_seq: int = Field(ge=0)
    payload_utf8: str
    payload_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    published_at_epoch: Seconds


class RouterTaskSnapshot(Record):
    """Complete remaining-work projection, published atomically by sys."""

    schema_version: Literal["1.0"]
    planning_as_of: Seconds
    horizon_start_at: Seconds
    horizon_end_at: Seconds
    requests: list[Request]
    engineers: list[Engineer]
    policy: Policy

    @model_validator(mode="after")
    def check_identity(self) -> Self:
        """Ensure a positive horizon and unique business identities/order fields."""
        if self.horizon_end_at <= self.horizon_start_at:
            raise ValueError("horizon must be positive")
        for rows, fields in (
            (self.requests, ("request_id", "arrival_order")),
            (self.engineers, ("engineer_id", "input_order")),
        ):
            for name in fields:
                values = [getattr(row, name) for row in rows]
                if len(values) != len(set(values)):
                    raise ValueError(f"duplicate {name}")
        return self


class Reason(Record):
    """Machine-readable evidence, never a claim of proven global optimality."""

    code: str
    text: str
    basis: Literal["constraint_check", "calculation_outcome"]
    facts: dict[str, str | int | float | bool | None] = Field(default_factory=dict)


class Diagnostic(Record):
    """Technical failure, separate from a valid unassigned outcome."""

    code: str
    message: str
    field_path: str | None = None
    entity_id: str | None = None


class Geometry(Record):
    """Ordered geographic points on the selected road path."""

    points: list[GeoPoint]


class RouteStop(Record):
    """Non-overlapping work, waiting or lunch interval."""

    stop_id: str
    sequence: int
    kind: Literal["job", "lunch", "wait"]
    request_id: str | None
    location: GeoPoint
    arrival_at: Seconds
    start_at: Seconds
    end_at: Seconds

    @model_validator(mode="after")
    def check_interval(self) -> Self:
        """Enforce local ordering and job identity before cross-route validation."""
        if not self.arrival_at <= self.start_at <= self.end_at:
            raise ValueError("invalid stop interval")
        if (self.kind == "job") != (self.request_id is not None):
            raise ValueError("only job stops must reference a request")
        return self


class RouteLeg(Record):
    """Travel quote used in both calculation and displayed geometry."""

    leg_id: str
    from_stop_id: str | None
    to_stop_id: str
    departure_at: Seconds
    arrival_at: Seconds
    travel_time_sec: Seconds
    distance_km: Annotated[float, Field(ge=0)]
    geometry: Geometry | None
    travel_source: TravelProvenance
    traffic_factor: Annotated[float, Field(ge=1.0)] = 1.0

    @model_validator(mode="after")
    def check_interval(self) -> Self:
        """Travel duration equals elapsed time on the selected leg."""
        if self.arrival_at - self.departure_at != self.travel_time_sec:
            raise ValueError("leg timestamps disagree with travel duration")
        return self


class LunchResult(Record):
    """Distinguish actual lunch facts, scheduled lunch and conflicts."""

    status: Literal[
        "disabled",
        "already_taken",
        "scheduled",
        "skipped_for_work",
        "not_scheduled",
        "required_conflict",
    ]
    stop_id: str | None = None
    reasons: list[Reason] = Field(default_factory=list)
    alert_id: str | None = None


class RouteMetrics(Record):
    """Durations in seconds; distances in kilometres."""

    distance_km: float = 0.0
    travel_time_sec: int = 0
    work_time_sec: int = 0
    waiting_time_sec: int = 0
    lunch_time_sec: int = 0
    assigned_count: int = 0


class PlanMetrics(RouteMetrics):
    """Snapshot-remaining totals; lunch-only engineers do not count as used."""

    requests_total: int = 0
    unassigned_count: int = 0
    urgent_total: int = 0
    urgent_assigned_count: int = 0
    engineers_used: int = 0
    late_assigned_count: int = 0
    total_lateness_sec: int = 0
    min_window_slack_sec: int | None = None
    workload_spread_sec: int = 0
    max_workload_sec: int = 0


class EngineerRoute(Record):
    """One open route per input engineer, including empty routes."""

    engineer_id: str
    start_location: GeoPoint
    start_at: Seconds | None
    finish_at: Seconds | None
    stops: list[RouteStop]
    legs: list[RouteLeg]
    lunch: LunchResult
    metrics: RouteMetrics
    reasons: list[Reason] = Field(default_factory=list)


class Assignment(Record):
    """Exactly one planning outcome per request, unrelated to execution status."""

    request_id: str
    status: Literal["assigned", "unassigned"]
    engineer_id: str | None
    stop_id: str | None
    reasons: list[Reason]


class PlanningAlert(Record):
    """Actionable explanation without implicit cancellation of any request."""

    alert_id: str
    code: str
    severity: Literal["info", "warning", "error"]
    engineer_ids: list[str]
    request_ids: list[str]
    reasons: list[Reason]
    restore_option: None = None


class Plan(Record):
    """Validated plan; unusable plans must not be applied by sys."""

    is_usable: bool
    metric_scope: Literal["snapshot_remaining"] = "snapshot_remaining"
    routes: list[EngineerRoute]
    assignments: list[Assignment]
    summary: PlanMetrics
    alerts: list[PlanningAlert]


class CandidateEvidence(Record):
    """Structured compatibility and append checks for one engineer alternative."""

    engineer_id: str
    label: str | None
    skills: list[Skill]
    transport_type: Transport
    equipment_stock: int | None
    release_at: int | None
    shift_end_at: int
    skill_match: bool
    transport_match: bool
    equipment_match: bool
    available: bool
    solo_feasible: bool
    append_at_route_end_feasible: bool
    append_start_at: int | None
    append_end_at: int | None
    append_incremental_travel_time_sec: int | None
    append_incremental_distance_km: float | None
    assigned_job_count: int
    blockers: list[str]


class RequestEvidence(Record):
    """Calculation-backed assignment facts for deterministic UI and LLM input."""

    request_id: str
    status: Literal["assigned", "unassigned"]
    priority: Literal["normal", "urgent"]
    required_skill: Skill
    required_transport: Transport | None
    required_equipment: EquipmentType | None
    service_duration_sec: int
    window_start_at: int
    window_end_at: int
    engineer_id: str | None
    stop_id: str | None
    predecessor_request_id: str | None
    arrival_at: int | None
    start_at: int | None
    end_at: int | None
    waiting_time_sec: int | None
    window_start_offset_sec: int | None
    window_end_margin_sec: int | None
    travel_time_sec: int | None
    distance_km: float | None
    reason_codes: list[str]
    reasons: list[Reason]
    candidates: list[CandidateEvidence]


class PlanEvidence(Record):
    """Versioned evidence bundle kept separate from the route decision itself."""

    schema_version: Literal["1.0"] = "1.0"
    requests: list[RequestEvidence]


class PolicyComparisonRow(Record):
    """One independently calculated strategy on the shared comparison snapshot."""

    strategy_id: Literal["fast", "compact", "sla", "balanced", "eco", "covering", "baseline"]
    kind: Literal["policy", "baseline"]
    additional_engineers: int = Field(default=0, ge=0)
    is_usable: bool
    calculation_ms: int = Field(ge=0)
    summary: PlanMetrics


class PolicyComparison(Record):
    """Cached comparison; covering explicitly reports its additional workforce."""

    input_publication_id: ID
    input_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    router_context_version: ID
    computed_at: Seconds
    search_budget_ms: int = Field(gt=0, le=8000)
    rows: list[PolicyComparisonRow] = Field(min_length=7, max_length=7)

    @model_validator(mode="after")
    def check_rows(self) -> Self:
        """Require the complete catalog exactly once, including the FIFO baseline."""
        expected = {"fast", "compact", "sla", "balanced", "eco", "covering", "baseline"}
        observed = [row.strategy_id for row in self.rows]
        if set(observed) != expected or len(set(observed)) != len(observed):
            raise ValueError("comparison must contain every strategy exactly once")
        if any((row.strategy_id == "baseline") != (row.kind == "baseline") for row in self.rows):
            raise ValueError("comparison row kind contradicts strategy")
        return self


class RouterResult(Record):
    """Atomic pair of main/baseline belonging to one input and resource context."""

    schema_version: Literal["1.0"] = "1.0"
    status: Literal["pending", "ready", "error"]
    result_id: str | None = None
    input_publication_id: str | None = None
    input_hash: str | None = None
    planning_as_of: int | None = None
    computed_at: int | None = None
    router_context_version: str | None = None
    policy_id: str | None = None
    technical_settings: RouterTechnicalSettings | None = None
    search_path: str | None = None
    policy_criteria: list[str] = Field(default_factory=list)
    main: Plan | None = None
    baseline: Plan | None = None
    main_evidence: PlanEvidence | None = None
    baseline_evidence: PlanEvidence | None = None
    errors: list[Diagnostic] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_state(self) -> Self:
        """Reject partial publications whose status contradicts their payload."""
        if self.input_hash is not None and (
            len(self.input_hash) != 64
            or any(character not in "0123456789abcdef" for character in self.input_hash)
        ):
            raise ValueError("input_hash must be lowercase SHA-256")
        payload = (self.main, self.baseline, self.main_evidence, self.baseline_evidence)
        if self.status == "ready":
            required = (
                self.result_id,
                self.input_hash,
                self.planning_as_of,
                self.computed_at,
                self.router_context_version,
                self.policy_id,
                self.technical_settings,
                self.search_path,
            )
            if any(value is None for value in required) or any(value is None for value in payload):
                raise ValueError("ready result is incomplete")
            if self.errors or not self.policy_criteria:
                raise ValueError("ready result has errors or no policy criteria")
        elif self.status == "error":
            if any(value is not None for value in payload) or not self.errors:
                raise ValueError("error result must contain diagnostics and no plans")
        elif any(value is not None for value in payload) or self.errors:
            raise ValueError("pending result cannot contain plans or errors")
        return self
