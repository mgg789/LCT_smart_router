import { describe, expect, it } from 'vitest';
import { aiLabEnabled } from './AiLabPage';

/**
 * `AiLabPage` itself is not rendered here: it wires a live `useAssistantChat` conversation
 * (network, localStorage) that has no place in this project's network-free unit tests (see
 * `AlertsPage.test.ts`). What must hold regardless of environment is the dev-only gate, so
 * that is what this tests directly -- the same pure predicate the component calls before
 * rendering anything.
 */
describe('/ai-lab dev-only gate', () => {
  it('renders in a dev build', () => {
    expect(aiLabEnabled({ DEV: true })).toBe(true);
  });

  it('renders with the explicit opt-in flag even outside dev', () => {
    expect(aiLabEnabled({ DEV: false, VITE_AI_LAB: '1' })).toBe(true);
  });

  it('renders nothing outside dev with no opt-in', () => {
    expect(aiLabEnabled({ DEV: false })).toBe(false);
    expect(aiLabEnabled({})).toBe(false);
    expect(aiLabEnabled({ DEV: false, VITE_AI_LAB: '0' })).toBe(false);
  });
});
