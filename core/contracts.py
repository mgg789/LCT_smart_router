"""Strict v14 JSON boundary; timestamps and durations are integer seconds."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

ID = Annotated[str, Field(min_length=1)]
Seconds = Annotated[int, Field(ge=0)]
PositiveSeconds = Annotated[int, Field(gt=0)]
Transport = Literal["car", "walk", "bike", "transit"]
Skill = Literal["local", "connection", "emergency"]


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
    position_observed_at: Seconds | None
    availability: Literal["online", "offline"]
    expected_online_at: Seconds | None
    lunch_taken: bool
    lunch: LunchInput

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

    policy_id: Literal["fast", "compact"]
    parameters: dict[str, str | int | float | bool | None]

    @model_validator(mode="after")
    def check_parameters(self) -> Self:
        """Reject unsupported preferences instead of pretending they were applied."""
        if self.parameters:
            raise ValueError(f"{self.policy_id} v1 accepts only empty parameters")
        return self


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


class RouterResult(Record):
    """Atomic pair of main/baseline belonging to one input and resource context."""

    schema_version: Literal["1.0"] = "1.0"
    status: Literal["pending", "ready", "error"]
    result_id: str | None = None
    input_hash: str | None = None
    planning_as_of: int | None = None
    computed_at: int | None = None
    router_context_version: str | None = None
    main: Plan | None = None
    baseline: Plan | None = None
    errors: list[Diagnostic] = Field(default_factory=list)
