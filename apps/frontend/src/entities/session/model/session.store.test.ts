import { afterEach, describe, expect, it } from 'vitest';
import { isSessionAlive, useSessionStore } from './session.store';

const nowSeconds = () => Math.floor(Date.now() / 1000);

afterEach(() => {
  useSessionStore.getState().signOut();
});

describe('session store', () => {
  it('keeps the session that was signed in', () => {
    const session = {
      token: 'tok',
      role: 'dispatcher' as const,
      expiresAt: nowSeconds() + 3600,
      email: 'dispatcher@navix.test',
    };

    useSessionStore.getState().signIn(session);

    expect(useSessionStore.getState().session).toEqual(session);
  });

  it('drops the session on sign-out', () => {
    useSessionStore.getState().signIn({
      token: 'tok',
      role: 'dispatcher',
      expiresAt: nowSeconds() + 3600,
      email: 'd@navix.test',
    });

    useSessionStore.getState().signOut();

    expect(useSessionStore.getState().session).toBeNull();
  });
});

describe('isSessionAlive', () => {
  it('treats a missing session as dead', () => {
    expect(isSessionAlive(null)).toBe(false);
  });

  it('treats an expired token as dead — expiresAt is Unix seconds', () => {
    expect(
      isSessionAlive({
        token: 'tok',
        role: 'dispatcher',
        expiresAt: nowSeconds() - 1,
        email: 'd@navix.test',
      }),
    ).toBe(false);
  });

  it('accepts a token that still has time left', () => {
    expect(
      isSessionAlive({
        token: 'tok',
        role: 'dispatcher',
        expiresAt: nowSeconds() + 60,
        email: 'd@navix.test',
      }),
    ).toBe(true);
  });
});
