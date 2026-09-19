import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createDevSnapshot } from '../fixtures/dev-day';
import { EngineersPage } from './EngineersPage';

describe('engineer roster write access', () => {
  it.each([true, false])(
    'reflects writesDisabled=%s in every availability switch',
    (writesDisabled) => {
      const markup = renderToStaticMarkup(
        createElement(EngineersPage, {
          snapshot: createDevSnapshot(),
          pendingEngineerId: null,
          rebuilding: false,
          writesDisabled,
          onAvailabilityChange: () => {},
          onLinkAccount: async () => {},
          onUnlinkAccount: async () => {},
        }),
      );
      const switches = [...markup.matchAll(/<input\b[^>]*role="switch"[^>]*>/g)];
      expect(switches.length).toBeGreaterThan(0);
      for (const [input] of switches) {
        expect(input.includes('disabled=""')).toBe(writesDisabled);
      }
    },
  );
});

import { createElement } from 'react';
