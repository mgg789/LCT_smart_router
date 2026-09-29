import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  type ExpectedSmokePlan,
  followsSmokeEquipmentIssue,
  matchesSmokePlan,
  readSmokePublication,
  type SmokePlanResponse,
  type SmokePublication,
} from '../../scripts/smoke-plan';

const expected: ExpectedSmokePlan = {
  requestIds: ['urgent'],
  engineerId: 'engineer',
  inputHash: 'new-hash',
  minRevision: 5,
  previousResultId: 'old-result',
};
const applied: SmokePlanResponse = {
  mode: 'auto',
  plan: {
    revision: 6,
    origin: 'auto',
    planAsOf: 1789840663,
    assignments: [{ requestId: 'urgent', status: 'assigned', engineerId: 'engineer' }],
  },
  appliedResult: { resultId: 'new-result', inputHash: 'new-hash' },
  lastResult: { resultId: 'old-result', accepted: true, rejectionCode: null },
};

describe('smoke applied-plan evidence', () => {
  it('accepts the applied plan when same-second diagnostics still point to the previous result', () => {
    assert.equal(matchesSmokePlan(applied, expected), true);
  });
  it('does not accept diagnostics without an applied relation', () => {
    assert.equal(matchesSmokePlan({ ...applied, appliedResult: null }, expected), false);
  });
  it('rejects the wrong task hash even if requests and revision look current', () => {
    assert.equal(
      matchesSmokePlan(
        { ...applied, appliedResult: { resultId: 'new-result', inputHash: 'another-task' } },
        expected,
      ),
      false,
    );
  });
  it('requires both a new revision and a new applied result for the urgent event', () => {
    assert.equal(matchesSmokePlan(applied, { ...expected, minRevision: 6 }), false);
    assert.equal(matchesSmokePlan(applied, { ...expected, previousResultId: 'new-result' }), false);
  });
  it('rejects a missing assignment, the wrong engineer, and manual state', () => {
    assert.equal(matchesSmokePlan(applied, { ...expected, requestIds: ['missing'] }), false);
    assert.equal(matchesSmokePlan(applied, { ...expected, engineerId: 'other' }), false);
    assert.equal(matchesSmokePlan({ ...applied, mode: 'manual' }, expected), false);
  });
});

const task = {
  schema_version: '1.0',
  planning_as_of: 1789840663,
  policy: { policy_id: 'balanced' },
  requests: [{ request_id: 'urgent', window_end_at: 1789847863 }],
  engineers: [
    {
      engineer_id: 'engineer',
      availability: 'online',
      shift_end_at: 1789876663,
      equipment_capacity: 30,
      equipment_stock: { router: 0, set_top_box: 0, smart_speaker: 0 },
    },
  ],
};
type Task = typeof task;

/** Encode realistic stored bytes so the tests also prove exact hash validation. */
function publication(value: Task, sequence = 1): SmokePublication {
  const payload = JSON.stringify(value);
  return {
    published: true,
    publicationId: `publication-${sequence}`,
    publicationSeq: sequence,
    inputHash: createHash('sha256').update(payload).digest('hex'),
    planningAsOf: value.planning_as_of,
    generation: 2,
    trigger: sequence === 1 ? 'request.submitted' : 'engineer.equipment_issued',
    payload,
  };
}

const stockedTask: Task = {
  ...task,
  planning_as_of: task.planning_as_of + 1,
  engineers: task.engineers.map((engineer) => ({
    ...engineer,
    equipment_stock: { router: 2, set_top_box: 2, smart_speaker: 2 },
  })),
};
const originalPublication = publication(task);
const issuedPublication = publication(stockedTask, 2);

describe('smoke morning-equipment publication', () => {
  it('recognizes the real stock-only publication following plan acceptance', () => {
    assert.equal(
      followsSmokeEquipmentIssue(originalPublication, issuedPublication, 'engineer'),
      true,
    );
    const currentPlan = {
      ...applied,
      appliedResult: { resultId: 'issued-result', inputHash: issuedPublication.inputHash },
    };
    // This is the pre-fix timeout: the original publication was already superseded.
    assert.equal(
      matchesSmokePlan(currentPlan, { ...expected, inputHash: originalPublication.inputHash }),
      false,
    );
    assert.equal(
      matchesSmokePlan(currentPlan, { ...expected, inputHash: issuedPublication.inputHash }),
      true,
    );
  });

  it('verifies stored UTF-8 bytes and rejects missing or mismatched metadata', () => {
    assert.deepEqual(readSmokePublication(originalPublication), originalPublication);
    assert.equal(readSmokePublication({ ...originalPublication, published: false }), null);
    assert.equal(readSmokePublication({ ...originalPublication, inputHash: '0'.repeat(64) }), null);
    assert.equal(
      readSmokePublication({ ...originalPublication, payload: `${originalPublication.payload} ` }),
      null,
    );
  });

  it('rejects another trigger, reset generation, old sequence and reused publication id', () => {
    for (const override of [
      { trigger: 'request.submitted' },
      { generation: 3 },
      { publicationSeq: 1 },
      { publicationId: originalPublication.publicationId },
    ]) {
      assert.equal(
        followsSmokeEquipmentIssue(
          originalPublication,
          { ...issuedPublication, ...override },
          'engineer',
        ),
        false,
      );
    }
  });

  it('rejects changes to request windows, policy, availability or shift', () => {
    const mutations: Task[] = [
      {
        ...stockedTask,
        requests: task.requests.map((request) => ({ ...request, window_end_at: 1789848000 })),
      },
      { ...stockedTask, policy: { policy_id: 'eco' } },
      {
        ...stockedTask,
        engineers: stockedTask.engineers.map((item) => ({ ...item, availability: 'offline' })),
      },
      {
        ...stockedTask,
        engineers: stockedTask.engineers.map((item) => ({ ...item, shift_end_at: 1789890000 })),
      },
      { ...stockedTask, requests: [] },
    ];
    for (const mutation of mutations) {
      assert.equal(
        followsSmokeEquipmentIssue(originalPublication, publication(mutation, 2), 'engineer'),
        false,
      );
    }
  });

  it('rejects a pure clock tick, decreasing stock and another engineer stock change', () => {
    assert.equal(
      followsSmokeEquipmentIssue(
        originalPublication,
        publication({ ...task, planning_as_of: task.planning_as_of + 1 }, 2),
        'engineer',
      ),
      false,
    );
    const reduced = publication(
      {
        ...stockedTask,
        engineers: stockedTask.engineers.map((item) => ({
          ...item,
          equipment_stock: { ...item.equipment_stock, router: 1 },
        })),
      },
      3,
    );
    assert.equal(followsSmokeEquipmentIssue(issuedPublication, reduced, 'engineer'), false);
    const [firstEngineer] = task.engineers;
    assert.ok(firstEngineer);
    const other = { ...firstEngineer, engineer_id: 'other' };
    const twoEngineers = publication({ ...task, engineers: [...task.engineers, other] });
    const changedBoth = publication(
      {
        ...stockedTask,
        engineers: [
          ...stockedTask.engineers,
          { ...other, equipment_stock: { router: 1, set_top_box: 0, smart_speaker: 0 } },
        ],
      },
      2,
    );
    assert.equal(followsSmokeEquipmentIssue(twoEngineers, changedBoth, 'engineer'), false);
  });

  it('rejects invalid JSON and a payload timestamp inconsistent with metadata', () => {
    const malformed = {
      ...issuedPublication,
      payload: '{',
      inputHash: createHash('sha256').update('{').digest('hex'),
    };
    assert.equal(followsSmokeEquipmentIssue(originalPublication, malformed, 'engineer'), false);
    assert.equal(
      followsSmokeEquipmentIssue(
        originalPublication,
        { ...issuedPublication, planningAsOf: task.planning_as_of },
        'engineer',
      ),
      false,
    );
  });
});
