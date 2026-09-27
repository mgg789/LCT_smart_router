import { t } from '../i18n';

/**
 * Setup kit for the dashboard MCP server: pin generation, the self-connecting
 * `setup.md` the dispatcher hands to their agent, and the browser download.
 *
 * Everything here is pure except [[downloadMcpSetupMd]] — the markdown is composed
 * on the client from values the dispatcher already sees (origin and pin); the server
 * never re-reveals the pin.
 */

const PIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A pin the dispatcher can actually read aloud: four groups of four, no ambiguous glyphs. */
export function generateMcpPin(): string {
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((value) => PIN_ALPHABET[value % PIN_ALPHABET.length]);
  return [0, 4, 8, 12].map((start) => chars.slice(start, start + 4).join('')).join('-');
}

export interface McpSetupInput {
  /** Dashboard origin the agent connects to, e.g. `https://navix.droidje.com`. */
  origin: string;
  endpoint: string;
  pin: string;
}

/** Human-facing tool names, short enough for the agent to read before acting. */
const TOOL_CATALOGUE: ReadonlyArray<{ name: string; description: string }> = [
  {
    name: 'get_dispatcher_context',
    description: t('figma-dashboard.mcpSetup.5af4062b36'),
  },
  {
    name: 'get_routing_principles',
    description: t('figma-dashboard.mcpSetup.47ac59fcc0'),
  },
  {
    name: 'get_situation',
    description: t('figma-dashboard.mcpSetup.22a541366c'),
  },
  { name: 'get_plan', description: t('figma-dashboard.mcpSetup.9dbb757ec2') },
  {
    name: 'get_plan_explanations',
    description: t('figma-dashboard.mcpSetup.61931e9453'),
  },
  { name: 'list_requests', description: t('figma-dashboard.mcpSetup.3886c8cd19') },
  { name: 'get_request', description: t('figma-dashboard.mcpSetup.bae18b7dd2') },
  { name: 'list_alerts', description: t('figma-dashboard.mcpSetup.68111faebf') },
  { name: 'resolve_alert', description: t('figma-dashboard.mcpSetup.7b0457b723') },
  {
    name: 'ai_resolve_alert',
    description: t('figma-dashboard.mcpSetup.a120949c42'),
  },
  { name: 'list_engineers', description: t('figma-dashboard.mcpSetup.16694eb611') },
  {
    name: 'set_engineer_availability',
    description: t('figma-dashboard.mcpSetup.4c9d5be6f7'),
  },
  {
    name: 'get_policies',
    description: t('figma-dashboard.mcpSetup.fca8933993'),
  },
  {
    name: 'select_policy',
    description: t('figma-dashboard.mcpSetup.ad2380a3f7'),
  },
  {
    name: 'get_router_controls',
    description: t('figma-dashboard.mcpSetup.e39c24f090'),
  },
  {
    name: 'set_router_controls',
    description: t('figma-dashboard.mcpSetup.613977f3aa'),
  },
  {
    name: 'set_control_mode',
    description: t('figma-dashboard.mcpSetup.e6f7ee3eb7'),
  },
  {
    name: 'simulate_plan_change',
    description: t('figma-dashboard.mcpSetup.f6e84b334e'),
  },
  {
    name: 'review_action',
    description: t('figma-dashboard.mcpSetup.b7428b5699'),
  },
  {
    name: 'get_dispatcher_settings',
    description: t('figma-dashboard.mcpSetup.746b846580'),
  },
  { name: 'update_dispatcher_settings', description: t('figma-dashboard.mcpSetup.1c97190ae6') },
  { name: 'start_workday', description: t('figma-dashboard.mcpSetup.441f532ec8') },
  {
    name: 'close_shift',
    description: t('figma-dashboard.mcpSetup.a5cff3f080'),
  },
];

/** Renders the markdown file the dispatcher sends to their agent. */
export function renderMcpSetupMd(input: McpSetupInput): string {
  const url = `${input.origin.replace(/\/$/, '')}${input.endpoint}`;
  const tools = TOOL_CATALOGUE.map((tool) => `- \`${tool.name}\` — ${tool.description}`).join('\n');
  return t('figma-dashboard.mcpSetup.1a39e7a40c', {
    value0: url,
    value1: input.pin,
    value2: input.pin,
    value3: url,
    value4: input.pin,
    value5: url,
    value6: input.pin,
    value7: tools,
  });
}

/** Triggers a browser download of the setup file; safe to call from a click handler. */
export function downloadMcpSetupMd(input: McpSetupInput): void {
  const blob = new Blob([renderMcpSetupMd(input)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'setup.md';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
