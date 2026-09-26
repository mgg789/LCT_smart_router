import { expect, it } from 'vitest';
import { clientRequestIdFromPath, clientRequestPath, clientRequestSeo } from './clientRequestSeo';
import {
  CLIENT_SESSION_KEY,
  clearClientSession,
  readClientSession,
  writeClientSession,
} from './clientSession';

it('keeps a client session until it expires', () => {
  const storage = new Map<string, string>();
  const memory = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  };
  writeClientSession(memory, {
    token: 'client-token',
    email: 'a@b.c',
    expiresAt: 2_000,
  });
  expect(readClientSession(memory, 1_000_000)?.email).toBe('a@b.c');
  expect(readClientSession(memory, 2_000_000)).toBeNull();
  expect(storage.get(CLIENT_SESSION_KEY)).toBeUndefined();
  writeClientSession(memory, { token: 'client-token', email: 'a@b.c', expiresAt: 9 });
  clearClientSession(memory);
  expect(readClientSession(memory)).toBeNull();
});

it('builds a request path and does not invent a head tag', () => {
  expect(clientRequestPath('req 1')).toBe('/client/requests/req%201');
  expect(clientRequestIdFromPath('/client/requests/req%201')).toBe('req 1');
  expect(clientRequestIdFromPath('/client')).toBeNull();
  const seo = clientRequestSeo({
    id: 'req-1',
    addressText: 'ул. Лесная, 7',
    statusLabel: 'Назначена',
    problemTitle: 'Интернет не работает',
  });
  expect(seo.title).toContain('Назначена');
  expect(seo.path).toBe('/client/requests/req-1');
});
