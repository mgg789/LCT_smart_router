import { Injectable } from '@nestjs/common';
import type { Actor } from '../../auth';
import { hashToken } from '../../auth/secrets';
import { SysError } from '../../common/errors';
import { Clock } from '../../common/time';
import type { OperationContext } from '../../operations';
import { OperationsService } from '../../operations';
import { APP_STATE_KEYS, PrismaService, type Tx } from '../../persistence';
import {
  isMcpActive,
  MCP_ENDPOINT_PATH,
  normalizeMcpPin,
  parseMcpSettings,
  pinLast4,
  type McpActivity,
  type McpSettings,
  type McpSettingsView,
} from './mcp-settings';

/** Name of the `ApiToken` row that carries the MCP pin hash. */
export const MCP_PIN_TOKEN_NAME = 'MCP dashboard pin';

/**
 * State of the dashboard MCP server behind `GET/PUT dispatch/mcp`, plus the credential
 * resolution and the activity marker of the transport endpoint.
 *
 * The pin itself is verified against a real `master` integration key row, so a bearer pin
 * is resolved by the same auth-engine as any other key and the journal shows who acted.
 * Only the hash lives in the database; the settings row keeps the key id and the last four
 * characters for the settings screen.
 */
@Injectable()
export class McpService {
  /** Wall-clock marker of the last tool call; process-local by design. */
  private activity: McpActivity | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly operations: OperationsService,
  ) {}

  async readSettings(db: PrismaService | Tx = this.prisma): Promise<McpSettings> {
    const row = await db.appState.findUnique({
      where: { key: APP_STATE_KEYS.MCP_SETTINGS },
    });
    return parseMcpSettings(row?.value ?? null);
  }

  /** Settings view for the dashboard: switch state, pin presence and live activity. */
  async view(): Promise<McpSettingsView> {
    const settings = await this.readSettings();
    return {
      enabled: settings.enabled,
      pinSet: settings.tokenId !== null,
      pinLast4: settings.pinLast4,
      activeNow: isMcpActive(settings, this.activity, this.clock.nowSeconds()),
      lastToolName: this.activity?.tool ?? null,
      lastToolCallAt: this.activity?.at ?? null,
      endpoint: MCP_ENDPOINT_PATH,
    };
  }

  /** Refuses every tool call while the server is switched off (404, not a leak). */
  async assertEnabled(): Promise<McpSettings> {
    const settings = await this.readSettings();
    if (!settings.enabled) {
      throw SysError.notFound('MCP server', { reason: 'disabled' });
    }
    return settings;
  }

  /**
   * Resolves the `X-MCP-Pin` header into the actor of the stored master key. The bearer
   * path needs no resolver: the pin already is an `ApiToken`, so the auth-engine resolves
   * it on its own.
   */
  async resolvePin(pin: string): Promise<Actor | null> {
    const normalized = normalizeMcpPin(pin);
    if (normalized === null) return null;
    const settings = await this.readSettings();
    if (!settings.enabled || settings.tokenId === null) return null;
    const record = await this.prisma.apiToken.findUnique({
      where: { tokenHash: hashToken(normalized) },
    });
    if (!record || record.id !== settings.tokenId || record.revokedAt !== null) {
      return null;
    }
    if (record.expiresAt !== null && Number(record.expiresAt) <= this.clock.nowSeconds()) {
      return null;
    }
    return {
      kind: 'api_token',
      source: 'external_api',
      id: record.id,
      role: null,
      tokenCategory: record.category,
      accountId: null,
    };
  }

  /**
   * Switches the server and rotates the pin. Disabling revokes the key row, so a pin that
   * once worked stops working everywhere at once — including direct REST calls.
   */
  async replace(
    actor: Actor,
    dto: { operationId: string; enabled: boolean; pin?: string },
  ): Promise<McpSettingsView> {
    const outcome = await this.operations.execute(
      {
        operationId: dto.operationId,
        actor,
        action: 'dispatch.mcp.replace',
        payload: dto,
      },
      async (context) => this.replaceWithin(context, dto),
    );
    return outcome.result;
  }

  /** Marks that an agent has just called a tool, feeding the dashboard indicator. */
  touch(tool: string): void {
    this.activity = { tool, at: this.clock.nowSeconds() };
  }

  private async replaceWithin(
    context: OperationContext,
    dto: { enabled: boolean; pin?: string },
  ): Promise<McpSettingsView> {
    const current = await this.readSettingsFrom(context.tx);
    let tokenId = current.tokenId;
    let last4 = current.pinLast4;

    if (dto.pin !== undefined) {
      const pin = normalizeMcpPin(dto.pin);
      if (pin === null) {
        throw SysError.validationFailed(
          `The MCP pin must be a printable string of ${6}–${128} characters`,
        );
      }
      const hash = hashToken(pin);
      if (tokenId !== null) {
        await context.tx.apiToken.updateMany({
          where: { id: tokenId, revokedAt: null },
          data: { revokedAt: BigInt(context.now) },
        });
      }
      // Reusing a pin that was used before revives its row instead of colliding on the
      // unique hash: one pin always maps to exactly one key.
      const row = await context.tx.apiToken.upsert({
        where: { tokenHash: hash },
        create: {
          name: MCP_PIN_TOKEN_NAME,
          category: 'master',
          tokenHash: hash,
          createdAt: BigInt(context.now),
        },
        update: {
          name: MCP_PIN_TOKEN_NAME,
          category: 'master',
          revokedAt: null,
          expiresAt: null,
        },
      });
      tokenId = row.id;
      last4 = pinLast4(pin);
    }

    if (dto.enabled && tokenId === null) {
      throw SysError.validationFailed('Задайте MCP-пин до включения сервера');
    }
    if (!dto.enabled && tokenId !== null) {
      await context.tx.apiToken.updateMany({
        where: { id: tokenId, revokedAt: null },
        data: { revokedAt: BigInt(context.now) },
      });
      tokenId = null;
      last4 = null;
    }

    const next: McpSettings = {
      version: 1,
      enabled: dto.enabled,
      tokenId,
      pinLast4: last4,
      updatedAt: context.now,
    };
    await context.tx.appState.upsert({
      where: { key: APP_STATE_KEYS.MCP_SETTINGS },
      create: {
        key: APP_STATE_KEYS.MCP_SETTINGS,
        value: next,
        updatedAt: BigInt(context.now),
      },
      update: { value: next, updatedAt: BigInt(context.now) },
    });
    return {
      enabled: next.enabled,
      pinSet: next.tokenId !== null,
      pinLast4: next.pinLast4,
      activeNow: isMcpActive(next, this.activity, context.now),
      lastToolName: this.activity?.tool ?? null,
      lastToolCallAt: this.activity?.at ?? null,
      endpoint: MCP_ENDPOINT_PATH,
    };
  }

  private async readSettingsFrom(tx: Tx): Promise<McpSettings> {
    const row = await tx.appState.findUnique({ where: { key: APP_STATE_KEYS.MCP_SETTINGS } });
    return parseMcpSettings(row?.value ?? null);
  }
}
