import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigService } from '@nestjs/config';
import { AppConfigService } from '../../src/common/config';
import { type Env, validateEnv } from '../../src/common/config/env.schema';
import { FixedClock } from '../../src/common/time';
import type { NotificationIntent } from '../../src/generated/prisma/client';
import { renderMail } from '../../src/notifications/mail-templates';
import { renderMonthlyReport } from '../../src/notifications/monthly-report.pdf';
import {
  type MonthlyReportData,
  monthlyReportSchema,
} from '../../src/notifications/monthly-report.types';
import type { OutboundMail } from '../../src/notifications/smtp.transport';
import { SmtpGatewayService } from '../../src/notifications/smtp-gateway.service';
import type { PrismaService } from '../../src/persistence';

const report: MonthlyReportData = {
  version: 1,
  month: '2026-09',
  generatedAt: 1790067600,
  provisional: false,
  coverageStartAt: null,
  totals: {
    completed: 2,
    cancelled: 0,
    assumedCompleted: 1,
    workMinutes: 95,
    engineerCount: 2,
    earnedPoints: 115,
    penaltyPoints: -50,
    teamAverage: 32.5,
  },
  engineers: [
    {
      engineerId: '1',
      name: 'Алексей Волков',
      points: 65,
      earnedPoints: 115,
      penaltyPoints: -50,
      ratio: 2,
      completed: 2,
      workMinutes: 95,
      categories: { arrival: 40, completion: 40, passport: 35, penalty: -50 },
    },
    {
      engineerId: '2',
      name: 'Мария Новикова',
      points: 0,
      earnedPoints: 0,
      penaltyPoints: 0,
      ratio: 0,
      completed: 0,
      workMinutes: 0,
      categories: { arrival: 0, completion: 0, passport: 0, penalty: 0 },
    },
  ],
  days: [
    {
      workDate: '2026-09-22',
      score: 89.5,
      evaluated: true,
      completed: 2,
      alertsResolved: 3,
      alertsTotal: 3,
    },
  ],
  notes: [],
};

test('monthly PDF embeds Cyrillic fonts and has no spurious footer pages', async () => {
  const buffer = await renderMonthlyReport(monthlyReportSchema.parse(report));
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-');
  const source = buffer.toString('latin1');
  assert.equal((source.match(/\/Type \/Page\b/g) ?? []).length, 3);
  assert.match(source, /\/FontFile2/);
  assert.ok(buffer.length > 10_000);
});

test('large monthly PDF paginates the full engineer roster and days', async () => {
  const engineer = report.engineers[0];
  const day = report.days[0];
  assert.ok(engineer && day);
  const expanded = {
    ...report,
    engineers: Array.from({ length: 35 }, (_, index) => ({
      ...engineer,
      engineerId: String(index),
      name: `Инженер ${index + 1} — длинная фамилия и имя для проверки переносов`,
    })),
    days: Array.from({ length: 30 }, (_, index) => ({
      ...day,
      workDate: `2026-09-${String(index + 1).padStart(2, '0')}`,
    })),
  };
  const buffer = await renderMonthlyReport(expanded);
  const pages = (buffer.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
  assert.ok(pages >= 10 && pages < 20, `Unexpected page count: ${pages}`);
});

test('monthly mail identifies its period and explains the PDF attachment', () => {
  const mail = renderMail(
    'dispatcher_monthly_report',
    { month: report.month },
    { appBaseUrl: 'https://example.test', timeZone: 'Europe/Moscow' },
  );
  assert.match(mail.subject, /2026-09/);
  assert.match(mail.text, /PDF/);
  assert.match(mail.html, /баллы инженеров/);
});

test('SMTP submits a frozen monthly PDF once and preserves the report reference', async () => {
  let intent: NotificationIntent = {
    id: 'mail-1',
    category: 'dispatcher_monthly_report',
    businessEventKey: 'month:2026-09:dispatcher',
    recipientEmail: 'dispatcher@example.test',
    payload: { month: report.month, reportKey: `reports.monthly.${report.month}` },
    state: 'pending_submission',
    createdAt: 1n,
    submittedAt: null,
    error: null,
  };
  const sent: OutboundMail[] = [];
  const db = {
    notificationIntent: {
      findUnique: async () => intent,
      updateMany: async ({ data }: { data: Partial<NotificationIntent> }) => {
        intent = { ...intent, ...data };
        return { count: 1 };
      },
    },
    appState: { findUnique: async () => ({ value: report }) },
  };
  const config = new AppConfigService(
    new ConfigService<Env, true>(
      validateEnv({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://unused@localhost:1/test',
        DISPATCHER_EMAIL: 'dispatcher@example.test',
        DISPATCHER_PASSWORD: 'unit-test-password',
      }),
    ),
  );
  const gateway = new SmtpGatewayService(
    config,
    db as unknown as PrismaService,
    new FixedClock(100),
    {
      verify: async () => true,
      send: async (mail) => {
        sent.push(mail);
        return { kind: 'accepted', response: '250 test accepted' };
      },
    },
    null,
  );
  await gateway.submitById('mail-1');
  await gateway.submitById('mail-1');
  assert.equal(sent.length, 1);
  const pdf = sent[0]?.attachments?.find(
    (attachment) => attachment.contentType === 'application/pdf',
  );
  assert.equal(pdf?.filename, 'navix-2026-09.pdf');
  assert.equal(pdf?.cid, undefined);
  assert.equal(pdf?.content.subarray(0, 5).toString(), '%PDF-');
  assert.equal(intent.state, 'accepted_by_server');
  assert.deepEqual(intent.payload, {
    month: report.month,
    reportKey: `reports.monthly.${report.month}`,
  });
});
