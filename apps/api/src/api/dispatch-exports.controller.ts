import { Controller, Get, Res, StreamableFile } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Roles } from '../auth';
import { SysError } from '../common/errors';
import {
  canonicalTextAddress,
  isCoordinateAddress,
} from '../orchestrator/passports/passport-policy';
import { PrismaService } from '../persistence';
import { AppliedPlanService } from '../routing/router-gateway';
import { renderPlanWorkbook } from './plan-export';
import { toPlanView } from './plan-view';
import { toRequestView } from './request-view';

const CSV_TEMPLATE =
  '\uFEFFID заявки,Адрес,Широта,Долгота,Тип работы,Длительность (мин),Окно от,Окно до,Приоритет,Навык,Нужный транспорт\r\n';

/** Read-only dispatcher downloads, shared by the UI and authorized external API clients. */
@Roles('dispatcher')
@ApiTags('dispatch')
@Controller('dispatch')
export class DispatchExportsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: AppliedPlanService,
  ) {}

  @Get('data/requests/template.csv')
  @ApiOperation({ summary: 'Download the CSV request import template' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  template(@Res({ passthrough: true }) response: Response): StreamableFile {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="navix-requests-template.csv"');
    return new StreamableFile(Buffer.from(CSV_TEMPLATE, 'utf8'));
  }

  @Get('plan/export.xlsx')
  @ApiOperation({ summary: 'Download the current applied plan as a two-sheet XLSX workbook' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async plan(@Res({ passthrough: true }) response: Response): Promise<StreamableFile> {
    response.setHeader('Cache-Control', 'no-store');
    const applied = await this.plans.current(this.prisma);
    if (!applied) throw SysError.notFound('Current applied plan');
    const plan = toPlanView(applied);
    const requestIds = [...new Set(plan.assignments.map((item) => item.requestId))];
    const engineerIds = [...new Set(plan.routes.map((route) => route.engineerId))];
    const [rows, engineers] = await Promise.all([
      this.prisma.request.findMany({
        where: { id: { in: requestIds } },
        include: { clientAccount: { select: { email: true } } },
      }),
      this.prisma.engineer.findMany({
        where: { id: { in: engineerIds } },
        select: { id: true, displayName: true },
      }),
    ]);
    const addresses = new Map<string, string>();
    const cacheKeys = rows.flatMap((row) =>
      !canonicalTextAddress(row.addressText) &&
      isCoordinateAddress(row.addressText) &&
      row.lat !== null &&
      row.lon !== null
        ? [`${row.lat.toFixed(6)},${row.lon.toFixed(6)}`]
        : [],
    );
    const cached = await this.prisma.reverseGeocodeCache.findMany({
      where: { coordinateKey: { in: cacheKeys } },
      select: { coordinateKey: true, canonicalAddress: true },
    });
    const byCoordinate = new Map(cached.map((item) => [item.coordinateKey, item.canonicalAddress]));
    for (const row of rows) {
      const explicit = canonicalTextAddress(row.addressText);
      const coordinate =
        row.lat !== null && row.lon !== null
          ? byCoordinate.get(`${row.lat.toFixed(6)},${row.lon.toFixed(6)}`)
          : undefined;
      const address = explicit ?? (isCoordinateAddress(row.addressText) ? coordinate : undefined);
      if (address) addresses.set(row.id, address);
    }
    const buildings = await this.prisma.building.findMany({
      where: { canonicalAddress: { in: [...new Set(addresses.values())] } },
      select: { canonicalAddress: true, passport: true },
    });
    const passports = new Map(buildings.map((item) => [item.canonicalAddress, item.passport]));
    const requests = new Map(
      rows.map(
        (row) =>
          [
            row.id,
            {
              view: toRequestView(row),
              clientEmail: row.clientAccount?.email ?? null,
              passport: passports.get(addresses.get(row.id) ?? '') ?? null,
            },
          ] as const,
      ),
    );
    const file = await renderPlanWorkbook({
      plan,
      requests,
      engineerNames: new Map(engineers.map((item) => [item.id, item.displayName])),
    });
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="navix-plan-${plan.revision}.xlsx"`,
    );
    return new StreamableFile(file);
  }
}
