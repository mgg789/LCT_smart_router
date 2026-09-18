import { describe, expect, it } from 'vitest';
import {
  clearEngineerSession,
  ENGINEER_SESSION_KEY,
  readEngineerSession,
  writeEngineerSession,
} from './session';

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

describe('engineer device session', () => {
  it('keeps a token for 30 days and drops it after expiry', () => {
    const store = storage();
    const issuedAt = Date.UTC(2026, 8, 18, 12, 0, 0);
    const expiresAt = issuedAt / 1000 + 30 * 86_400;
    writeEngineerSession(store, { token: 'engineer-token', expiresAt });

    expect(readEngineerSession(store, issuedAt + 10 * 86_400 * 1000)?.token).toBe('engineer-token');
    expect(store.getItem(ENGINEER_SESSION_KEY)).toContain('engineer-token');

    expect(readEngineerSession(store, expiresAt * 1000 + 1)).toBeNull();
    expect(store.getItem(ENGINEER_SESSION_KEY)).toBeNull();
  });

  it('forgets a corrupted or empty payload', () => {
    const store = storage();
    store.setItem(ENGINEER_SESSION_KEY, '{');
    expect(readEngineerSession(store)).toBeNull();
    writeEngineerSession(store, { token: 'ok', expiresAt: Date.now() / 1000 + 60 });
    clearEngineerSession(store);
    expect(readEngineerSession(store)).toBeNull();
  });
});
