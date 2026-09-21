import { describe, expect, it } from 'vitest';
import type { AlertView } from '../api/types';
import { alertDecisionSeconds, alertWindowInput, alertWindowSeconds, isOpenAlert } from './alerts';

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
});
