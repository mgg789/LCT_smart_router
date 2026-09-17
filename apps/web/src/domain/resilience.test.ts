import { describe, expect, it } from 'vitest';
import { DashboardApiError, parseDashboardSnapshot } from '../api/client';
import { demoScenarios, recordedScenario } from '../demo/scenarios';
import {
  clearSavedDay,
  connectionDiagnostic,
  restoreDay,
  saveDay,
  startRecoverySession,
} from './resilience';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}

describe('session-bound last-good view', () => {
  it('survives reload in the same session, redacts contact details and rejects expired/anonymous access', () => {
    const store = storage();
    const now = Date.now();
    startRecoverySession(store, Math.floor(now / 1000) + 60);
    const base = recordedScenario('initial').snapshot;
    const day = {
      ...base,
      requests: base.requests.map((r) => ({
        ...r,
        contactName: 'Private name',
        problemText: 'Private text',
      })),
    };
    expect(saveDay(store, day, now)).toBe(true);
    expect(restoreDay(store, true, now)?.snapshot.requests[0]?.contactName).toBeNull();
    expect(restoreDay(store, false, now)).toBeNull();
    expect(restoreDay(store, true, now + 61_000)).toBeNull();
  });

  it('clears old data when login changes or the user signs out', () => {
    const store = storage();
    startRecoverySession(store, Math.floor(Date.now() / 1000) + 600);
    saveDay(store, recordedScenario('initial').snapshot);
    startRecoverySession(store, Math.floor(Date.now() / 1000) + 600);
    expect(restoreDay(store, true)).toBeNull();
    clearSavedDay(store);
    expect(store.length).toBe(0);
  });

  it('does not overwrite a valid copy with inconsistent references', () => {
    const store = storage();
    startRecoverySession(store, Math.floor(Date.now() / 1000) + 600);
    const day = recordedScenario('initial').snapshot;
    expect(saveDay(store, day)).toBe(true);
    expect(saveDay(store, { ...day, engineers: [] })).toBe(false);
    expect(restoreDay(store, true)?.snapshot.engineers.length).toBe(5);
  });

  it('handles corrupt storage and denied writes without breaking live operation', () => {
    const store = storage();
    store.setItem('lct.saved-day.scope', 'broken');
    expect(restoreDay(store, true)).toBeNull();
    const denied = {
      ...storage(),
      setItem() {
        throw new Error('Quota exceeded');
      },
    };
    expect(() => startRecoverySession(denied, 9999999999)).not.toThrow();
    expect(saveDay(denied, recordedScenario('initial').snapshot)).toBe(false);
  });

  it('exports only redacted diagnostic metadata', () => {
    const error = new DashboardApiError(
      'token=secret and user body',
      503,
      '/api/v1/dispatch/plan?token=secret',
      'trace_123',
    );
    const diagnostic = connectionDiagnostic(error);
    expect(diagnostic).toMatchObject({
      endpoint: '/api/v1/dispatch/plan',
      status: 503,
      requestId: 'trace_123',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('secret');
  });
});

describe('recorded demo bundle', () => {
  it('validates every scenario/policy, references and metric totals', () => {
    for (const scenario of demoScenarios) {
      for (const policy of ['compact', 'fast', 'sla', 'balanced', 'eco'] as const) {
        const data = recordedScenario(scenario.id, policy);
        expect(parseDashboardSnapshot(data.snapshot).workDate).toBe('2026-08-17');
        const row = data.comparison.rows.find((item) => item.strategyId === policy);
        const assigned = data.snapshot.plan.plan?.assignments.filter(
          (item) => item.status === 'assigned',
        ).length;
        expect(row?.metrics.assignedCount).toBe(assigned);
        expect(row?.metrics.requestsTotal).toBe(data.snapshot.requests.length);
        expect(data.comparison.inputHash).toBe(data.snapshot.plan.appliedResult?.inputHash);
        expect(data.comparison.rows).toHaveLength(6);
      }
    }
  });

  it('replays meaningful separate changes and resets without mutating recorded data', () => {
    expect(recordedScenario('urgent').snapshot.requests).toHaveLength(19);
    expect(recordedScenario('unavailable').snapshot.engineers[0]?.day?.availability).toBe(
      'offline',
    );
    expect(recordedScenario('lunch').snapshot.lunchesEnabled).toBe(true);
    const day = recordedScenario('initial').snapshot;
    day.requests.pop();
    expect(recordedScenario('initial').snapshot.requests).toHaveLength(18);
    expect(() => recordedScenario('unknown')).toThrow();
  });
});
