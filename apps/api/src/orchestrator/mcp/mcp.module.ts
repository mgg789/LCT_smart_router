import { Global, Module } from '@nestjs/common';
import { LiveModule } from '../live/live.module';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { McpToolsService } from './mcp-tools';

/**
 * The dashboard MCP server: the transport endpoint, the pin/switch state and the tool
 * registry.
 *
 * Global because the dispatcher contour reaches the same state — `GET/PUT dispatch/mcp`
 * in `DispatchController` reads and replaces the settings through [[McpService]]. Every
 * other dependency (operations, alerts, AI, policies, settings, router gateway) arrives
 * via the already-global modules; only LIVE is imported explicitly.
 */
@Global()
@Module({
  imports: [LiveModule],
  controllers: [McpController],
  providers: [McpService, McpToolsService],
  exports: [McpService],
})
export class McpModule {}
