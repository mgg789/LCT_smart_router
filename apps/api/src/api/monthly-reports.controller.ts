import { Controller, Get, Param, Res, StreamableFile } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Roles } from '../auth';
import { Clock } from '../common/time';
import { renderMonthlyReport } from '../notifications/monthly-report.pdf';
import { assertMonth, MonthlyReportsService } from '../notifications/monthly-reports.service';
import { moscowMonth } from '../orchestrator/passports/passport-policy';

/** Dispatcher PDF export for a frozen or current provisional monthly report. */
@Roles('dispatcher')
@ApiTags('reports')
@Controller('dispatch/reports')
export class MonthlyReportsController {
  constructor(
    private readonly reports: MonthlyReportsService,
    private readonly clock: Clock,
  ) {}

  @Get('monthly/:month')
  @ApiOperation({ summary: 'Monthly dispatcher report as PDF' })
  async monthly(
    @Param('month') month: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    assertMonth(month, moscowMonth(this.clock.nowSeconds()));
    const report = await this.reports.read(month);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader('Content-Disposition', `attachment; filename="navix-${month}.pdf"`);
    return new StreamableFile(await renderMonthlyReport(report));
  }

  @Get('monthly/:month/data')
  @ApiOperation({ summary: 'Monthly dispatcher report JSON data' })
  async data(@Param('month') month: string) {
    return this.reports.read(month);
  }
}
