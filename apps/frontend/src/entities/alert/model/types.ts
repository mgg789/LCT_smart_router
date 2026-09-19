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

export interface AlertView {
  id: string;
  code: string;
  severity: AlertSeverity;
  engineerIds: string[];
  requestIds: string[];
  reasons: SolverReason[];
  restoreOption?: string | null;
  /** Unix seconds. */
  createdAt: number;
  seenAt: number | null;
  resolvedAt: number | null;
}

export interface AlertsView {
  alerts: AlertView[];
}
