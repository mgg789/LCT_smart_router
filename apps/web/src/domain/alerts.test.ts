import { describe, expect, it } from 'vitest';
import type { AlertView } from '../api/types';
import {
  ALERT_ACTION_LABELS,
  ALERT_ACTION_SPECS,
  alertDecisionSeconds,
  alertWindowInput,
  alertWindowSeconds,
  isAlertActionId,
  isOpenAlert,
} from './alerts';

const alert: AlertView = {
  id: 'a',
  code: 'unassigned',
  severity: 'warning',
  engineerIds: [],
  requestIds: [],
  reasons: [],
  restoreOption: null,
  createdAt: 1000,
  seenAt: null,
  resolvedAt: null,
};

describe('dispatcher alert lifecycle projection', () => {
  it('does not confuse reading, notices and resolving', () => {
    expect(isOpenAlert({ ...alert, seenAt: 1100 })).toBe(true);
    expect(isOpenAlert({ ...alert, kind: 'notice' })).toBe(false);
    expect(isOpenAlert({ ...alert, resolvedAt: 1200 })).toBe(false);
  });
  it('starts measuring at second 181 and freezes at resolution', () => {
    expect(alertDecisionSeconds(alert, 1180)).toBe(0);
    expect(alertDecisionSeconds(alert, 1181)).toBe(1);
    expect(alertDecisionSeconds({ ...alert, resolvedAt: 1250 }, 9999)).toBe(70);
    expect(alertDecisionSeconds({ ...alert, resolvedAt: 1250, resolutionDelaySec: 70 }, 9999)).toBe(
      70,
    );
  });
  it('converts dispatcher windows as Moscow time regardless of device timezone', () => {
    const unix = alertWindowSeconds('2026-09-20T09:30');
    expect(new Date(unix * 1000).toISOString()).toBe('2026-09-20T06:30:00.000Z');
    expect(alertWindowInput(unix)).toBe('2026-09-20T09:30');
    expect(() => alertWindowSeconds('invalid')).toThrow();
  });
  it('documents every server action with short copy and a decision trade-off', () => {
    const serverActions = [
      'reschedule',
      'move_window',
      'add_engineer',
      'keep_manual',
      'keep_as_is',
      'restore_auto',
      'skip_lunch',
      'keep_lunch',
      'message',
      'remove_shift',
      'message_remove',
      'extend',
    ] as const;
    expect(Object.keys(ALERT_ACTION_SPECS)).toEqual(serverActions);
    for (const action of serverActions) {
      const spec = ALERT_ACTION_SPECS[action];
      expect(ALERT_ACTION_LABELS[action]).toBe(spec.label);
      expect(spec.label.split(/\s+/u).length).toBeLessThanOrEqual(3);
      expect(spec.effect.length).toBeGreaterThan(20);
      expect(spec.benefit.length).toBeGreaterThan(20);
      expect(spec.drawback.length).toBeGreaterThan(20);
      expect(isAlertActionId(action)).toBe(true);
    }
    expect(isAlertActionId('ai')).toBe(false);
  });
});
