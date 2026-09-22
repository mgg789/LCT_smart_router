import { describe, expect, it } from 'vitest';
import { resolveRoute } from './App';

describe('top-level route switch', () => {
  it('resolves the engineer app for /engineer and its sub-paths', () => {
    expect(resolveRoute('/engineer')).toBe('engineer');
    expect(resolveRoute('/engineer/route')).toBe('engineer');
    expect(resolveRoute('/engineer/requests/abc')).toBe('engineer');
  });

  it('resolves the client app for /client and its sub-paths', () => {
    expect(resolveRoute('/client')).toBe('client');
    expect(resolveRoute('/client/new')).toBe('client');
    expect(resolveRoute('/client/assistant')).toBe('client');
  });

  it('resolves the ai-lab developer stand for /ai-lab', () => {
    expect(resolveRoute('/ai-lab')).toBe('ai-lab');
    expect(resolveRoute('/ai-lab/anything')).toBe('ai-lab');
  });

  it('falls back to the dispatcher dashboard for everything else', () => {
    expect(resolveRoute('/')).toBe('dashboard');
    expect(resolveRoute('/alerts')).toBe('dashboard');
    expect(resolveRoute('/engineers')).toBe('dashboard');
  });
});
