import { z } from 'zod';

/**
 * Persistent settings of the dashboard MCP server.
 *
 * The MCP pin is stored as a real `master` integration key (`ApiToken` row), so a bearer
 * pin passes the same auth-engine resolution as any other key. This row only records the
 * switch state, which key belongs to the pin, and the last four characters for the UI —
 * never the pin itself.
 */

/** Transport path of the JSON-RPC endpoint, under the global `/api/v1` prefix. */
export const MCP_ENDPOINT_PATH = '/api/v1/mcp';

/** Shortest acceptable pin. The UI generates a far longer one; this is the floor. */
export const MCP_PIN_MIN_LENGTH = 6;
export const MCP_PIN_MAX_LENGTH = 128;

/** A call on any tool counts as "an agent is working" for this long. */
export const MCP_ACTIVITY_WINDOW_SEC = 30;

const storedSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  /** `ApiToken.id` of the row that carries the pin hash; null while no pin is set. */
  tokenId: z.string().nullable(),
  pinLast4: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
});

/** A type alias on purpose: Prisma accepts only object types as its Json input. */
export type McpSettings = {
  readonly version: 1;
  readonly enabled: boolean;
  readonly tokenId: string | null;
  readonly pinLast4: string | null;
  readonly updatedAt: number;
};

/** What the dashboard Settings → API tab is shown. The pin itself never travels back. */
export interface McpSettingsView {
  readonly enabled: boolean;
  readonly pinSet: boolean;
  readonly pinLast4: string | null;
  /** True while some agent has called an MCP tool within [[MCP_ACTIVITY_WINDOW_SEC]]. */
  readonly activeNow: boolean;
  readonly lastToolName: string | null;
  readonly lastToolCallAt: number | null;
  readonly endpoint: string;
}

/** Reads persisted JSON, falling back to "disabled, no pin". */
export function parseMcpSettings(value: unknown): McpSettings {
  const parsed = storedSchema.safeParse(value ?? {});
  if (!parsed.success) {
    return { version: 1, enabled: false, tokenId: null, pinLast4: null, updatedAt: 0 };
  }
  return parsed.data;
}

function isPrintable(pin: string): boolean {
  return [...pin].every((char) => {
    const code = char.charCodeAt(0);
    return code > 31 && code !== 127;
  });
}

/** Accepts a pin the dispatcher typed: trimmed, printable, within the length bounds. */
export function normalizeMcpPin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const pin = value.trim();
  if (pin.length < MCP_PIN_MIN_LENGTH || pin.length > MCP_PIN_MAX_LENGTH) return null;
  if (!isPrintable(pin)) return null;
  return pin;
}

/** Last four characters for the settings screen, mirroring the map-key presentation. */
export function pinLast4(pin: string): string | null {
  return pin.length < 4 ? pin : pin.slice(-4);
}

/** Durable activity marker of the most recent tool call. */
export interface McpActivity {
  readonly tool: string;
  readonly at: number;
}

export function isMcpActive(
  settings: McpSettings,
  activity: McpActivity | null,
  nowSeconds: number,
): boolean {
  if (!settings.enabled || activity === null) return false;
  return nowSeconds - activity.at <= MCP_ACTIVITY_WINDOW_SEC;
}
