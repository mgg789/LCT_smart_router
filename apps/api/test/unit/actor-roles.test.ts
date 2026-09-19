import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Actor, effectiveRoles } from '../../src/auth/actor';
import type { ApiTokenCategory, Role } from '../../src/generated/prisma/client';

/** A minimal integration-key actor; only `tokenCategory` matters for the mapping. */
const keyActor = (category: ApiTokenCategory): Actor => ({
  kind: 'api_token',
  source: 'external_api',
  id: 'token-1',
  role: null,
  tokenCategory: category,
  accountId: null,
});

const sessionActor = (role: Role): Actor => ({
  kind: 'account',
  source: 'ui',
  id: 'account-1',
  role,
  tokenCategory: null,
  accountId: 'account-1',
});

describe('token category to role mapping', () => {
  it('maps each app key onto exactly its own contour', () => {
    assert.deepEqual(effectiveRoles(keyActor('client')), ['client']);
    assert.deepEqual(effectiveRoles(keyActor('eng')), ['engineer']);
  });

  it('maps the both-app key onto the client and engineer contours, never the dispatcher', () => {
    assert.deepEqual(effectiveRoles(keyActor('client_eng')), ['client', 'engineer']);
  });

  it('maps the master key onto every contour including the dispatcher', () => {
    assert.deepEqual(effectiveRoles(keyActor('master')), ['dispatcher', 'client', 'engineer']);
  });

  it('never lets a token category raise a session role', () => {
    assert.deepEqual(effectiveRoles(sessionActor('client')), ['client']);
    assert.deepEqual(effectiveRoles(sessionActor('dispatcher')), ['dispatcher']);
  });

  it('maps an unknown category onto no role at all', () => {
    const actor: Actor = {
      kind: 'api_token',
      source: 'external_api',
      id: 'token-1',
      role: null,
      tokenCategory: null,
      accountId: null,
    };
    assert.deepEqual(effectiveRoles(actor), []);
  });
});
