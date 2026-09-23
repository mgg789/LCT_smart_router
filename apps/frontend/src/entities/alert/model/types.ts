/** Severity as the System Layer reports it (docs/frontend-api.md §5). */
export type AlertSeverity = 'info' | 'warning' | 'error';

/**
 * A reason from the solver, not a sentence to print. `basis` says whether it is a
 * checked constraint or the outcome of a limited search — the difference matters
 * and must survive into the UI (docs/frontend-api.md §10).
 */
export interface SolverReason {
  code: string;
  text: string;
  basis: 'constraint_check' | 'calculation_outcome';
  facts?: Record<string, unknown>;
}

/**
 * `alert` waits for a dispatcher's decision; `notice` only informs and never
 * blocks the day (docs/api.md, «Алерты и уведомления»).
 */
export type AlertKind = 'alert' | 'notice';

export interface AlertView {
  id: string;
  /** Absent only on rows stored before alerts and notices were told apart. */
  kind?: AlertKind;
  code: string;
  severity: AlertSeverity;
  engineerIds: string[];
  requestIds: string[];
  /**
   * The situation's facts as the detector recorded them — structured objects
   * such as `{assignment: "unassigned"}`, not sentences. Read them through
   * `alertReasonText`.
   */
  reasons: unknown[];
  restoreOption?: unknown;
  /** Decisions the server will accept for this alert; empty for a notice. */
  actions?: string[];
  /** Unix seconds. */
  createdAt: number;
  seenAt: number | null;
  resolvedAt: number | null;
  resolutionAction?: string | null;
  resolutionReason?: string | null;
  workDate?: string | null;
}

export interface AlertsView {
  alerts: AlertView[];
}
