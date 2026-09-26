import { Body, Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { Actor } from '../../auth';
import { effectiveRoles } from '../../auth';
import { Public } from '../../common/access';
import { SysError } from '../../common/errors';
import { PreAuthRateLimit } from '../../common/rate-limit';
import { McpService } from './mcp.service';
import { handleMcpPayload, type McpProtocolHost } from './mcp-protocol';
import { McpToolsService } from './mcp-tools';

/**
 * Transport of the dashboard MCP server: one stateless JSON-RPC endpoint under
 * `/api/v1/mcp` (streamable HTTP, JSON replies only — no server-initiated SSE).
 *
 * Credentials: the MCP pin travels either as `Authorization: Bearer <pin>` (it is a real
 * master integration key, so the global guard resolves it like any other token) or as the
 * `X-MCP-Pin` header for clients that cannot replace the bearer value. A dispatcher
 * session works too — all three end up as a dispatcher-power actor for the journal.
 */
@ApiTags('mcp')
@Controller('mcp')
@Public()
export class McpController {
  constructor(
    private readonly mcp: McpService,
    private readonly tools: McpToolsService,
  ) {}

  @Post()
  @PreAuthRateLimit({ scope: 'mcp:transport', max: 30, windowSec: 60 })
  @ApiOperation({ summary: 'MCP JSON-RPC endpoint (initialize, tools/list, tools/call)' })
  async handle(
    @Req() request: Request & { actor?: Actor },
    @Res() response: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const actor = await this.authorize(request);
    const host: McpProtocolHost = {
      listTools: () => this.tools.listTools(),
      callTool: (name, args) => this.tools.call(name, args, actor),
    };
    const outcome = await handleMcpPayload(body, host);
    if (outcome.kind === 'accepted') {
      response.status(202).end();
      return;
    }
    response.status(outcome.status).json(outcome.body);
  }

  @Get()
  @ApiOperation({ summary: 'Not offered: this server sends no server-initiated streams' })
  streamsNotOffered(@Res() response: Response): void {
    response.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP transport accepts POST only' },
    });
  }

  @Delete()
  @ApiOperation({ summary: 'Not offered: the endpoint is stateless and keeps no session' })
  sessionNotOffered(@Res() response: Response): void {
    response.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'MCP transport keeps no session to close' },
    });
  }

  /**
   * Establishes the acting dispatcher-power identity, or refuses the call. A presented
   * bearer was already resolved by the global guard (an unusable one never gets here), so
   * only the header path and the role check remain.
   */
  private async authorize(request: Request & { actor?: Actor }): Promise<Actor> {
    const bearer = request.actor;
    if (bearer) {
      if (!effectiveRoles(bearer).includes('dispatcher')) {
        throw SysError.forbidden('MCP acts on behalf of the dispatcher');
      }
      await this.mcp.assertEnabled();
      return bearer;
    }
    const pin = request.header('x-mcp-pin');
    if (!pin || pin.trim().length === 0) {
      throw new SysError(
        'UNAUTHENTICATED',
        'MCP requires the X-MCP-Pin header or a bearer credential',
      );
    }
    const actor = await this.mcp.resolvePin(pin);
    if (!actor) {
      throw new SysError('UNAUTHENTICATED', 'The MCP pin is not valid');
    }
    await this.mcp.assertEnabled();
    return actor;
  }
}
