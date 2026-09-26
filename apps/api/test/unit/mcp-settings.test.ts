import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isMcpActive,
  normalizeMcpPin,
  parseMcpSettings,
  pinLast4,
} from '../../src/orchestrator/mcp/mcp-settings';

describe('mcp settings', () => {
  it('falls back to a disabled server without a pin', () => {
    assert.deepEqual(parseMcpSettings(null), {
      version: 1,
      enabled: false,
      tokenId: null,
      pinLast4: null,
      updatedAt: 0,
    });
    assert.deepEqual(parseMcpSettings({ garbage: true }), {
      version: 1,
      enabled: false,
      tokenId: null,
      pinLast4: null,
      updatedAt: 0,
    });
  });

  it('reads back a persisted row', () => {
    const stored = {
      version: 1,
      enabled: true,
      tokenId: 'token-1',
      pinLast4: 'ab12',
      updatedAt: 123,
    };
    assert.deepEqual(parseMcpSettings(stored), stored);
  });

  it('accepts a printable pin within the length bounds and trims it', () => {
    assert.equal(normalizeMcpPin('  ab12cd  '), 'ab12cd');
    assert.equal(normalizeMcpPin('12345'), null, 'below the floor');
    assert.equal(normalizeMcpPin('a'.repeat(129)), null, 'above the ceiling');
    assert.equal(normalizeMcpPin(12345), null);
    assert.equal(normalizeMcpPin('a\tb'), null, 'control characters are refused');
  });

  it('keeps at least the last four characters for the settings screen', () => {
    assert.equal(pinLast4('ab12cd'), '12cd');
    assert.equal(pinLast4('abc'), 'abc');
    assert.equal(pinLast4(''), '');
  });

  it('counts activity only while the server is enabled and fresh', () => {
    const settings = {
      version: 1 as const,
      enabled: true,
      tokenId: 't',
      pinLast4: 'ab12',
      updatedAt: 1,
    };
    assert.equal(isMcpActive(settings, { tool: 'get_situation', at: 100 }, 129), true);
    assert.equal(isMcpActive(settings, { tool: 'get_situation', at: 100 }, 131), false);
    assert.equal(isMcpActive({ ...settings, enabled: false }, { tool: 'x', at: 100 }, 105), false);
    assert.equal(isMcpActive(settings, null, 105), false);
  });
});
