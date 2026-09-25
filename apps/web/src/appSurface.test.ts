import { expect, it } from 'vitest';
import { appSurface, appSurfaceTitle } from './appSurface';

it('keeps /client and nested client paths off the dispatcher shell', () => {
  expect(appSurface('/client')).toBe('client');
  expect(appSurface('/client/')).toBe('client');
  expect(appSurface('/client/requests')).toBe('client');
  expect(appSurface('/engineer')).toBe('engineer');
  expect(appSurface('/')).toBe('dispatcher');
});

it('uses the requested Navix browser-tab titles', () => {
  expect(appSurfaceTitle('dispatcher')).toBe('Navix | Дашборд');
  expect(appSurfaceTitle('engineer')).toBe('Navix | Инженер');
  expect(appSurfaceTitle('client')).toBe('ЛК | Navix');
});
