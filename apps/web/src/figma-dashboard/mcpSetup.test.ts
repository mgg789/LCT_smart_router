import { describe, expect, it } from 'vitest';
import { generateMcpPin, renderMcpSetupMd } from './mcpSetup';

describe('mcp setup', () => {
  it('generates a readable pin of four groups from an unambiguous alphabet', () => {
    const pin = generateMcpPin();
    expect(pin).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/);
    for (let i = 0; i < 20; i += 1) {
      expect(generateMcpPin()).not.toBe(pin);
    }
  });

  it('renders the endpoint, both header styles and the tool catalogue', () => {
    const markdown = renderMcpSetupMd({
      origin: 'https://navix.droidje.com/',
      endpoint: '/api/v1/mcp',
      pin: 'AB2C-DE3F-GH4J-KM5N',
    });
    expect(markdown).toContain('https://navix.droidje.com/api/v1/mcp');
    expect(markdown).toContain('"X-MCP-Pin": "AB2C-DE3F-GH4J-KM5N"');
    expect(markdown).toContain('Bearer AB2C-DE3F-GH4J-KM5N');
    expect(markdown).toContain('`get_plan_explanations`');
    expect(markdown).toContain('`review_action`');
    expect(markdown).toContain('`simulate_plan_change`');
    expect(markdown).toContain('Риск');
    expect(markdown).toContain('claude mcp add');
    expect(markdown).not.toContain('undefined');
  });
});
