import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toRequestView } from '../../src/api/request-view';
import type { Request } from '../../src/generated/prisma/client';

describe('request view duration evidence', () => {
  it('exposes the norm components and derives confirmed duration variance', () => {
    const request: Request = {
      id: 'request-1',
      clientAccountId: null,
      arrivalOrder: 1,
      addressText: 'Test address',
      district: null,
      region: 'east',
      lat: 55.75,
      lon: 37.61,
      needsGeocoding: false,
      normProfileCode: 'local_repair',
      normativeTravelDurationSec: 1200,
      technicalDurationSec: 1800,
      documentationDurationSec: 0,
      serviceDurationSec: 1800,
      windowStartAt: 1_000n,
      windowEndAt: 2_000n,
      windowOrigin: 'explicit',
      priority: 'normal',
      requiredSkill: 'local',
      requiredTransport: null,
      requiredEquipment: null,
      workTypeHd: 'monitoring',
      lifecycle: 'completed',
      assignmentState: 'assigned',
      origin: 'system_rule',
      problemText: null,
      contactName: null,
      createdAt: 900n,
      submittedAt: 950n,
      startedAt: 1_100n,
      expectedCompletionAt: 2_900n,
      continuationAvailableAt: 2_600n,
      overrunDetectedAt: null,
      completedAt: 2_600n,
      cancelledAt: null,
      updatedAt: 2_600n,
      version: 4,
    };

    const view = toRequestView(request);

    assert.equal(view.normProfileCode, 'local_repair');
    assert.equal(view.region, 'east');
    assert.equal(view.normativeTravelDurationSec, 1200);
    assert.equal(view.technicalDurationSec, 1800);
    assert.equal(view.documentationDurationSec, 0);
    assert.equal(view.serviceDurationSec, 1800);
    assert.equal(view.actualDurationSec, 1500);
    assert.equal(view.durationVarianceSec, -300);
    assert.equal(view.expectedCompletionAt, 2900);
    assert.equal(view.continuationAvailableAt, 2600);
    assert.equal(view.overrunDetectedAt, null);
  });
});
