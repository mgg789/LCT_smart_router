import { expect, it } from 'vitest';
import { appSurface } from './appSurface';

it('keeps /client and nested client paths off the dispatcher shell', () => {
  expect(appSurface('/client')).toBe('client');
  expect(appSurface('/client/')).toBe('client');
  expect(appSurface('/client/requests')).toBe('client');
  expect(appSurface('/engineer')).toBe('engineer');
  expect(appSurface('/')).toBe('dispatcher');
});
