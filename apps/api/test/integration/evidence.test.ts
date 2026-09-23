import '../support/env';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DispatchController } from '../../src/api/dispatch.controller';
import { AppModule } from '../../src/app.module';
import type { PrismaClient } from '../../src/generated/prisma/client';
import { createTestClient, databaseUrl, unique } from '../support/database';

/**
 * `GET /dispatch/requests/:id/evidence` against a stored applied plan.
 *
 * Exercises the real chain -- `AppliedPlanService.current()` -> the applied plan's own
 * `RouterResult.payload` -> `EvidenceReader.forRequest()` -- against a real Postgres row,
 * not a mock. A result computed with no evidence package returns the honest empty shape
 * (docs/api.md section 10's "next contract"), never an invented one.
 */
describe('dispatch requests/:id/evidence', () => {
  let context: INestApplicationContext;
  let prisma: PrismaClient;
  let controller: DispatchController;
  const routerResultIds: string[] = [];
  const planIds: string[] = [];
  let previousPointerPlanId: string | null = null;

  before(async () => {
    databaseUrl();
    prisma = createTestClient();
    await prisma.$connect();
    context = await NestFactory.createApplicationContext(AppModule, { logger: false });
    controller = context.get(DispatchController);
    const pointer = await prisma.appliedPlanCurrent.findUnique({ where: { id: 'singleton' } });
    previousPointerPlanId = pointer?.planId ?? null;
  });

  after(async () => {
    // Restore whichever revision was current before this file ran -- the pointer is a
    // process-wide singleton and other integration test files depend on it.
    if (previousPointerPlanId) {
      await prisma.appliedPlanCurrent.update({
        where: { id: 'singleton' },
        data: { planId: previousPointerPlanId },
      });
    } else {
      await prisma.appliedPlanCurrent.deleteMany({});
    }
    await prisma.appliedPlan.deleteMany({ where: { id: { in: planIds } } });
    await prisma.routerResult.deleteMany({ where: { id: { in: routerResultIds } } });
    await prisma.$disconnect();
    await context?.close();
  });

  async function applyPlanWithPayload(payload: object): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const result = await prisma.routerResult.create({
      data: {
        resultId: unique('evidence-result'),
        inputHash: unique('hash'),
        routerContextVersion: 'test-context',
        status: 'ready',
        planningAsOf: BigInt(now),
        computedAt: BigInt(now),
        receivedAt: BigInt(now),
        accepted: true,
        payload,
      },
    });
    routerResultIds.push(result.id);
    const plan = await prisma.appliedPlan.create({
      data: {
        origin: 'auto',
        routerResultId: result.id,
        planAsOf: BigInt(now),
        appliedAt: BigInt(now),
        note: 'evidence integration test',
      },
    });
    planIds.push(plan.id);
    await prisma.appliedPlanCurrent.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', planId: plan.id, updatedAt: BigInt(now) },
      update: { planId: plan.id, updatedAt: BigInt(now), pointerVersion: { increment: 1 } },
    });
  }

  it('returns the request and candidate evidence, basis included, from the stored payload', async () => {
    const requestId = unique('req');
    await applyPlanWithPayload({
      main_evidence: {
        schema_version: '1.0',
        requests: [
          {
            request_id: requestId,
            status: 'unassigned',
            priority: 'normal',
            required_skill: 'connection',
            required_transport: null,
            required_equipment: null,
            service_duration_sec: 900,
            window_start_at: 100,
            window_end_at: 200,
            engineer_id: null,
            stop_id: null,
            predecessor_request_id: null,
            arrival_at: null,
            start_at: null,
            end_at: null,
            waiting_time_sec: null,
            window_start_offset_sec: null,
            window_end_margin_sec: null,
            travel_time_sec: null,
            distance_km: null,
            reason_codes: ['NO_FEASIBLE_ASSIGNMENT_FOUND'],
            reasons: [
              {
                code: 'NO_FEASIBLE_ASSIGNMENT_FOUND',
                text: 'bounded search found no variant',
                basis: 'calculation_outcome',
                facts: {},
              },
            ],
            candidates: [
              {
                engineer_id: 'eng-1',
                label: 'Иван Кузнецов',
                skills: ['connection'],
                transport_type: 'car',
                equipment_stock: null,
                release_at: null,
                shift_end_at: 500,
                skill_match: true,
                transport_match: true,
                equipment_match: true,
                available: true,
                solo_feasible: true,
                append_at_route_end_feasible: false,
                append_start_at: null,
                append_end_at: null,
                append_incremental_travel_time_sec: null,
                append_incremental_distance_km: null,
                assigned_job_count: 3,
                blockers: ['current_route_append_infeasible'],
              },
            ],
          },
        ],
      },
      baseline_evidence: null,
    });

    const view = await controller.requestEvidence(requestId);
    assert.equal(view.requestId, requestId);
    assert.ok(view.main);
    assert.equal(view.main?.request_id, requestId);
    assert.equal(view.main?.reasons[0]?.basis, 'calculation_outcome');
    assert.deepEqual(view.main?.candidates[0]?.blockers, ['current_route_append_infeasible']);
    assert.equal(view.baseline, null);
  });

  it('returns an honest empty shape when the applied plan carries no evidence package', async () => {
    const requestId = unique('req');
    await applyPlanWithPayload({ main: null, baseline: null });

    const view = await controller.requestEvidence(requestId);
    assert.equal(view.requestId, requestId);
    assert.equal(view.main, null);
    assert.equal(view.baseline, null);
  });
});
