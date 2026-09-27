import { type AlertAction, alertActionsFor } from './alert-policy';

/** Stable dispatcher projection of a durable alert or informational notice. */
export interface AlertView {
  readonly id: string;
  readonly kind: 'alert' | 'notice';
  readonly code: string;
  readonly severity: string;
  readonly engineerIds: string[];
  readonly requestIds: string[];
  readonly reasons: unknown;
  readonly restoreOption: unknown;
  readonly actions: AlertAction[];
  readonly createdAt: number;
  readonly seenAt: number | null;
  readonly resolvedAt: number | null;
  readonly resolutionAction: string | null;
  readonly resolutionReason: string | null;
  readonly resolutionDelaySec: number | null;
  readonly workDate: string | null;
}

/** Converts the persistence row without querying or mutating state. */
export function toAlertView(
  alert: {
    id: string;
    kind: string;
    code: string;
    severity: string;
    engineerIds: string[];
    requestIds: string[];
    reasons: unknown;
    restoreOption: unknown;
    createdAt: bigint;
    seenAt: bigint | null;
    resolvedAt: bigint | null;
    resolutionAction: string | null;
    resolutionReason: string | null;
    resolutionDelaySec: number | null;
    workDate: string | null;
  },
  emergency = false,
): AlertView {
  return {
    id: alert.id,
    kind: alert.kind === 'notice' ? 'notice' : 'alert',
    code: alert.code,
    severity: alert.severity,
    engineerIds: alert.engineerIds,
    requestIds: alert.requestIds,
    reasons: Array.isArray(alert.reasons) ? alert.reasons : [alert.reasons],
    restoreOption: alert.restoreOption,
    actions:
      alert.kind === 'notice'
        ? []
        : alertActionsFor(alert.code).filter(
            (action) => !emergency || (action !== 'reschedule' && action !== 'move_window'),
          ),
    createdAt: Number(alert.createdAt),
    seenAt: alert.seenAt === null ? null : Number(alert.seenAt),
    resolvedAt: alert.resolvedAt === null ? null : Number(alert.resolvedAt),
    resolutionAction: alert.resolutionAction,
    resolutionReason: alert.resolutionReason,
    resolutionDelaySec: alert.resolutionDelaySec,
    workDate: alert.workDate,
  };
}
