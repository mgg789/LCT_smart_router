/**
 * The complete list of events that publish a new input sector.
 *
 * This enumeration is the matrix of context/42 section 3 written as code. Being a closed
 * list is the point: the rule is "no trigger, no publication", and the failure mode the
 * concept warns about is a system that republishes on any row changing anywhere.
 *
 * Deliberately absent, and each for a stated reason:
 *   * the passage of time by itself -- only crossing a persisted task-overrun threshold
 *     changes the projection;
 *   * a GPS point -- voluntary telemetry, not an input to routing;
 *   * a routine arrival or problem mark -- neither changes usable capacity;
 *   * silence from an engineer -- an expired estimate does not become `null`, an offline
 *     state or a refusal on its own (context/36 section 5.1);
 *   * reading a result, viewing an alert, signing in, importing knowledge, clearing old
 *     logs -- none of these change the task.
 */
export const PUBLICATION_TRIGGERS = {
  REQUEST_SUBMITTED: 'request.submitted',
  REQUEST_CONDITIONS_CHANGED: 'request.conditions_changed',
  REQUEST_CANCELLED: 'request.cancelled',
  /** Started work leaves the free pool and anchors its engineer at the task location. */
  REQUEST_EXECUTION_STARTED: 'request.execution_started',
  /** A confirmed finish changed usable capacity by more than the configured threshold. */
  REQUEST_EXECUTION_VARIANCE: 'request.execution_variance',
  /** An unfinished task exceeded its normative duration and configured tolerance. */
  REQUEST_EXECUTION_OVERRUN: 'request.execution_overrun',
  ENGINEER_CREATED: 'engineer.created',
  ENGINEER_PROFILE_CHANGED: 'engineer.profile_changed',
  ENGINEER_WORKDAY_CHANGED: 'engineer.workday_changed',
  ENGINEER_AVAILABILITY_CHANGED: 'engineer.availability_changed',
  EQUIPMENT_ISSUED: 'engineer.equipment_issued',
  /** The lunch of the day was actually started, so no second one may be planned. */
  ENGINEER_LUNCH_TAKEN: 'engineer.lunch_taken',
  /** A forecast the engineer explicitly reported, already interpreted by sys. */
  ENGINEER_FORECAST_CHANGED: 'engineer.forecast_changed',
  POLICY_CHANGED: 'policy.changed',
  /** The dispatcher's explicit restore-lunch decision. */
  LUNCH_RESTORED: 'lunch.restored',
  DATA_IMPORTED: 'data.imported',
  DATA_RESET: 'data.reset',
} as const;

export type PublicationTrigger = (typeof PUBLICATION_TRIGGERS)[keyof typeof PUBLICATION_TRIGGERS];
