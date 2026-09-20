import { describe, expect, it } from 'vitest';
import {
  ENGINEER_SESSION_KEY,
  clearEngineerSession,
  readEngineerSession,
  writeEngineerSession,
} from './session';

function memoryStorage() {
  const memory = new Map<string, string>();
  return {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memory.set(key, value);
    },
    removeItem: (key: string) => {
      memory.delete(key);
    },
  };
}

describe('engineer session', () => {
  it('keeps a live token and drops an expired one', () => {
    const storage = memoryStorage();
    writeEngineerSession(storage, {
      token: 'tok',
      email: 'a@b.ru',
      expiresAt: 2_000,
    });
    expect(readEngineerSession(storage, 1_000_000)).toEqual({
      token: 'tok',
      email: 'a@b.ru',
      expiresAt: 2_000,
    });
    expect(readEngineerSession(storage, 2_000_001)).toBeNull();
    expect(storage.getItem(ENGINEER_SESSION_KEY)).toBeNull();
  });

  it('forgets the device session on sign-out', () => {
    const storage = memoryStorage();
    writeEngineerSession(storage, { token: 'tok', email: 'a@b.ru', expiresAt: 9_999 });
    clearEngineerSession(storage);
    expect(readEngineerSession(storage)).toBeNull();
  });
});
