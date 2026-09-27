import type { AlertView } from '../api/types';
import { t } from '../i18n';

export type AlertActionId =
  | 'reschedule'
  | 'move_window'
  | 'add_engineer'
  | 'keep_manual'
  | 'keep_as_is'
  | 'restore_auto'
  | 'skip_lunch'
  | 'keep_lunch'
  | 'message'
  | 'remove_shift'
  | 'message_remove'
  | 'extend'
  | 'make_passive'
  | 'prioritize';

export type AlertActionTone = 'bee' | 'outline' | 'ink';

export interface AlertActionSpec {
  readonly id: AlertActionId;
  readonly label: string;
  readonly summary: string;
  readonly effect: string;
  readonly benefit: string;
  readonly drawback: string;
  readonly tone: AlertActionTone;
  readonly input: 'none' | 'window' | 'engineer' | 'reason' | 'minutes' | 'message';
}

/**
 * UI copy for the server's finite dispatcher decisions. Labels stay short while
 * the hover/focus explanation names the real mutation, benefit and trade-off.
 */
export const ALERT_ACTION_SPECS: Readonly<Record<AlertActionId, AlertActionSpec>> = {
  reschedule: {
    id: 'reschedule',
    label: t('domain.alerts.b8762d9355'),
    summary: t('domain.alerts.d823c0f9a1'),
    effect: t('domain.alerts.ea7a9f6dab'),
    benefit: t('domain.alerts.9ff15d7887'),
    drawback: t('domain.alerts.37a178a478'),
    tone: 'outline',
    input: 'none',
  },
  move_window: {
    id: 'move_window',
    label: t('domain.alerts.c5ee44d147'),
    summary: t('domain.alerts.02ae5507db'),
    effect: t('domain.alerts.5d6673c180'),
    benefit: t('domain.alerts.c10a0dbda0'),
    drawback: t('domain.alerts.a14b502d36'),
    tone: 'bee',
    input: 'window',
  },
  add_engineer: {
    id: 'add_engineer',
    label: t('domain.alerts.17ea4891c4'),
    summary: t('domain.alerts.4b95d02c35'),
    effect: t('domain.alerts.6ebbe91d15'),
    benefit: t('domain.alerts.f5c94a4f54'),
    drawback: t('domain.alerts.ae9c5c9f0e'),
    tone: 'ink',
    input: 'engineer',
  },
  keep_manual: {
    id: 'keep_manual',
    label: t('domain.alerts.2a3e76d8ed'),
    summary: t('domain.alerts.db565f3e48'),
    effect: t('domain.alerts.ead498e278'),
    benefit: t('domain.alerts.38cbfe77cd'),
    drawback: t('domain.alerts.c1680f2442'),
    tone: 'outline',
    input: 'reason',
  },
  keep_as_is: {
    id: 'keep_as_is',
    label: t('domain.alerts.53cd4960ed'),
    summary: t('domain.alerts.3e0c37d266'),
    effect: t('domain.alerts.e73b0b726c'),
    benefit: t('domain.alerts.4b128c0baa'),
    drawback: t('domain.alerts.951e584a4c'),
    tone: 'outline',
    input: 'none',
  },
  restore_auto: {
    id: 'restore_auto',
    label: t('domain.alerts.55fcc5e47f'),
    summary: t('domain.alerts.80a37622cd'),
    effect: t('domain.alerts.7ba0a25814'),
    benefit: t('domain.alerts.dd0a22c43c'),
    drawback: t('domain.alerts.66cd728d4d'),
    tone: 'bee',
    input: 'none',
  },
  skip_lunch: {
    id: 'skip_lunch',
    label: t('domain.alerts.1b44ad0995'),
    summary: t('domain.alerts.b8f2259425'),
    effect: t('domain.alerts.7203a347a4'),
    benefit: t('domain.alerts.3100e636d9'),
    drawback: t('domain.alerts.2e483d2760'),
    tone: 'ink',
    input: 'none',
  },
  keep_lunch: {
    id: 'keep_lunch',
    label: t('domain.alerts.b354f63deb'),
    summary: t('domain.alerts.ad64b40846'),
    effect: t('domain.alerts.ced1549b72'),
    benefit: t('domain.alerts.6a477a5200'),
    drawback: t('domain.alerts.44e28b87b5'),
    tone: 'bee',
    input: 'none',
  },
  message: {
    id: 'message',
    label: t('domain.alerts.35d80f592a'),
    summary: t('domain.alerts.40b75c4e6a'),
    effect: t('domain.alerts.a8cbbfc066'),
    benefit: t('domain.alerts.bc6bc0c708'),
    drawback: t('domain.alerts.8fc7ab1daa'),
    tone: 'bee',
    input: 'message',
  },
  remove_shift: {
    id: 'remove_shift',
    label: t('domain.alerts.f3dad72a3a'),
    summary: t('domain.alerts.f57392bad8'),
    effect: t('domain.alerts.27c48b3bef'),
    benefit: t('domain.alerts.9aea5e1623'),
    drawback: t('domain.alerts.6ad5454ac2'),
    tone: 'ink',
    input: 'none',
  },
  message_remove: {
    id: 'message_remove',
    label: t('domain.alerts.6d4dc83c1d'),
    summary: t('domain.alerts.7bb6d1ce88'),
    effect: t('domain.alerts.55bbfc522a'),
    benefit: t('domain.alerts.8a15c84332'),
    drawback: t('domain.alerts.7281e54f4c'),
    tone: 'ink',
    input: 'message',
  },
  extend: {
    id: 'extend',
    label: t('domain.alerts.dfc1ff6209'),
    summary: t('domain.alerts.501a4e3160'),
    effect: t('domain.alerts.81402f35d6'),
    benefit: t('domain.alerts.75b1f3b12c'),
    drawback: t('domain.alerts.fae5d7dc01'),
    tone: 'outline',
    input: 'minutes',
  },
  make_passive: {
    id: 'make_passive',
    label: t('domain.alerts.7d8d531646'),
    summary: t('domain.alerts.37080c4876'),
    effect: t('domain.alerts.d1d394da00'),
    benefit: t('domain.alerts.d343f22730'),
    drawback: t('domain.alerts.8bef94fb62'),
    tone: 'outline',
    input: 'none',
  },
  prioritize: {
    id: 'prioritize',
    label: t('domain.alerts.0e5ac36d3f'),
    summary: t('domain.alerts.fb74b8aed9'),
    effect: t('domain.alerts.c75948d24c'),
    benefit: t('domain.alerts.381af539ce'),
    drawback: t('domain.alerts.9b0093f021'),
    tone: 'bee',
    input: 'none',
  },
};

/** Short labels retained for history rows and other existing alert projections. */
export const ALERT_ACTION_LABELS: Readonly<Record<AlertActionId, string>> = Object.fromEntries(
  Object.values(ALERT_ACTION_SPECS).map((spec) => [spec.id, spec.label]),
) as Readonly<Record<AlertActionId, string>>;

/** Narrows untrusted action ids supplied by live or cached server snapshots. */
export function isAlertActionId(value: string): value is AlertActionId {
  return Object.hasOwn(ALERT_ACTION_SPECS, value);
}

/** Resolves known event codes without losing unknown server events. */
export function alertTitle(code: string): string {
  const titles: Readonly<Record<string, string>> = {
    time_risk: t('domain.alerts.669360fbf6'),
    engineer_line_started: t('domain.alerts.6091e70e04'),
    engineer_day_finished: t('domain.alerts.9fff7e495f'),
    workday_finished_with_alerts: t('domain.alerts.003bd3bc78'),
    unassigned: t('domain.alerts.a8bc20f761'),
    plan_degraded: t('domain.alerts.18c95cc7ca'),
    plan_review_required: t('domain.alerts.a64762b6c5'),
    lunch_conflict: t('domain.alerts.d922e1ca35'),
    engineer_overdue: t('domain.alerts.be6f95101c'),
    shift_no_show: t('domain.alerts.f01a62c9af'),
    plan_rebuilt: t('domain.alerts.b02a3bb901'),
    LIVE_TECHNICAL_BREAK_OVERRUN: t('domain.alerts.669360fbf6'),
    LIVE_WINDOW_COMPLETION_RISK: t('domain.alerts.669360fbf6'),
  };
  return titles[code] ?? code;
}

/** Read status never removes the requirement for a dispatcher decision. */
export function isOpenAlert(alert: AlertView): boolean {
  return alert.kind !== 'notice' && alert.resolvedAt === null;
}

/** The first 180 seconds are a grace period; elapsed second 181 is recorded as 1. */
export function alertDecisionSeconds(alert: AlertView, now: number): number {
  return alert.resolutionDelaySec ?? Math.max(0, (alert.resolvedAt ?? now) - alert.createdAt - 180);
}

/** Converts the UI's explicitly Moscow datetime input into Unix seconds. */
export function alertWindowSeconds(value: string): number {
  const result = Date.parse(`${value}:00+03:00`) / 1000;
  if (!Number.isInteger(result)) throw new Error(t('domain.alerts.ba8f7dae9e'));
  return result;
}

/** Formats persisted Unix time for a Moscow datetime-local input. */
export function alertWindowInput(seconds: number): string {
  return new Date((seconds + 3 * 3600) * 1000).toISOString().slice(0, 16);
}
