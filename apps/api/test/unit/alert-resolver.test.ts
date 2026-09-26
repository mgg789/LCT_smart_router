import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type AddEngineerCandidate, checkAlertResolutionPreconditions } from '../../src/ai/alerts';
import { buildAlertResolverSchema } from '../../src/ai/alerts/alert-resolver.schema';

/**
 * `buildAlertResolverSchema` and `checkAlertResolutionPreconditions` are the two refusal
 * layers of the alert resolver: an illegal action or engineer id cannot even parse
 * (task brief), and a legal-looking proposal still gets refused if it fails one of
 * `alerts.service.ts#applyAction`'s real preconditions. Neither layer ever coerces a bad
 * value into a legal one -- there is no retry loop nudging the model toward legality.
 */
describe('alert resolver: per-alert schema narrowing', () => {
  it('an action outside the alert code catalogue is refused -- it cannot even parse', () => {
    const schema = buildAlertResolverSchema({
      allowedActions: ['reschedule', 'move_window', 'add_engineer'],
      candidateEngineerIds: [],
    });
    const result = schema.safeParse({
      action: 'restore_auto', // not offered for this alert code
      reason: 'this action was never offered for this alert code at all',
      confidence: 0.8,
      rejected: [],
    });
    assert.equal(result.success, false);
  });

  it('an engineerId outside the server-computed candidate list is refused -- it cannot even parse', () => {
    const schema = buildAlertResolverSchema({
      allowedActions: ['add_engineer'],
      candidateEngineerIds: ['eng-vetted-1', 'eng-vetted-2'],
    });
    const result = schema.safeParse({
      action: 'add_engineer',
      engineerId: 'eng-never-vetted',
      reason: 'this engineer id was never in the candidate list the server computed',
      confidence: 0.8,
      rejected: [],
    });
    assert.equal(result.success, false);
  });

  it('a vetted engineerId from the candidate list parses successfully', () => {
    const schema = buildAlertResolverSchema({
      allowedActions: ['add_engineer'],
      candidateEngineerIds: ['eng-vetted-1'],
    });
    const result = schema.safeParse({
      action: 'add_engineer',
      engineerId: 'eng-vetted-1',
      reason: 'eng-vetted-1 is offline, has the skill and the region matches',
      confidence: 0.9,
      rejected: [],
    });
    assert.equal(result.success, true);
  });

  it('an allowed action still parses when nothing else is wrong', () => {
    const schema = buildAlertResolverSchema({
      allowedActions: ['keep_manual', 'restore_auto'],
      candidateEngineerIds: [],
    });
    const result = schema.safeParse({
      action: 'keep_manual',
      reason: 'the manual plan is deliberately kept for this operational reason',
      confidence: 0.7,
      rejected: [{ action: 'restore_auto', why: 'no verified restore option exists yet' }],
    });
    assert.equal(result.success, true);
  });

  it('rejected[] is capped at three alternatives', () => {
    const schema = buildAlertResolverSchema({
      allowedActions: ['message', 'remove_shift', 'extend'],
      candidateEngineerIds: [],
    });
    const result = schema.safeParse({
      action: 'message',
      reason: 'messaging the engineer is the least disruptive first step to try',
      confidence: 0.5,
      rejected: [
        { action: 'remove_shift', why: 'a' },
        { action: 'extend', why: 'b' },
        { action: 'message', why: 'c' },
        { action: 'remove_shift', why: 'd' },
      ],
    });
    assert.equal(result.success, false);
  });
});

describe('alert resolver: precondition refusals (mirrors alerts.service.ts#applyAction)', () => {
  const noCandidates: AddEngineerCandidate[] = [];
  const candidates: AddEngineerCandidate[] = [
    { engineerId: 'eng-1', displayName: 'Иван', region: 'Центр', skills: ['connection'] },
  ];
  const timeZone = 'Europe/Moscow';

  it('move_window is refused when the request is not submitted', () => {
    const why = checkAlertResolutionPreconditions(
      {
        action: 'move_window',
        windowDate: '2026-09-21',
        windowStartLocal: '10:00',
        windowEndLocal: '11:00',
        reason: 'moving the window to a later slot the same day',
        confidence: 0.8,
        rejected: [],
      },
      { code: 'time_risk', restoreOption: null },
      { lifecycle: 'in_progress' },
      noCandidates,
      timeZone,
    );
    assert.match(why ?? '', /submitted/);
  });

  it('move_window is refused when the new bounds are not ordered', () => {
    const why = checkAlertResolutionPreconditions(
      {
        action: 'move_window',
        windowDate: '2026-09-21',
        windowStartLocal: '11:00',
        windowEndLocal: '10:00',
        reason: 'moving the window but the end is before the start by mistake',
        confidence: 0.8,
        rejected: [],
      },
      { code: 'time_risk', restoreOption: null },
      { lifecycle: 'submitted' },
      noCandidates,
      timeZone,
    );
    assert.match(why ?? '', /ordered/);
  });

  it('add_engineer is refused when engineerId is missing or not a vetted candidate', () => {
    const missing = checkAlertResolutionPreconditions(
      {
        action: 'add_engineer',
        reason: 'adding an engineer to cover the leftover work in this zone',
        confidence: 0.6,
        rejected: [],
      },
      { code: 'unassigned', restoreOption: null },
      null,
      candidates,
      timeZone,
    );
    assert.match(missing ?? '', /candidate list/);

    const notVetted = checkAlertResolutionPreconditions(
      {
        action: 'add_engineer',
        engineerId: 'eng-not-vetted',
        reason: 'adding an engineer to cover the leftover work in this zone',
        confidence: 0.6,
        rejected: [],
      },
      { code: 'unassigned', restoreOption: null },
      null,
      candidates,
      timeZone,
    );
    assert.match(notVetted ?? '', /candidate list/);
  });

  it('extend is refused without minutes', () => {
    const why = checkAlertResolutionPreconditions(
      {
        action: 'extend',
        reason: 'giving the engineer more time before treating this as a no-show',
        confidence: 0.6,
        rejected: [],
      },
      { code: 'engineer_overdue', restoreOption: null },
      null,
      noCandidates,
      timeZone,
    );
    assert.match(why ?? '', /minutes/);
  });

  it('a shift_no_show extend only accepts exactly 15 minutes', () => {
    const why = checkAlertResolutionPreconditions(
      {
        action: 'extend',
        minutes: 30,
        reason: 'giving the engineer more time before treating this as a no-show',
        confidence: 0.6,
        rejected: [],
      },
      { code: 'shift_no_show', restoreOption: null },
      null,
      noCandidates,
      timeZone,
    );
    assert.match(why ?? '', /15 minutes/);

    const okay = checkAlertResolutionPreconditions(
      {
        action: 'extend',
        minutes: 15,
        reason: 'giving the engineer the standard 15 minute grace period',
        confidence: 0.6,
        rejected: [],
      },
      { code: 'shift_no_show', restoreOption: null },
      null,
      noCandidates,
      timeZone,
    );
    assert.equal(okay, null);
  });

  it('keep_manual is refused with an empty/whitespace-only reason', () => {
    const why = checkAlertResolutionPreconditions(
      {
        action: 'keep_manual',
        reason: '   ',
        confidence: 0.6,
        rejected: [],
      },
      { code: 'plan_degraded', restoreOption: null },
      null,
      noCandidates,
      timeZone,
    );
    assert.match(why ?? '', /non-empty reason/);
  });

  it('restore_auto is impossible when restoreOption is null', () => {
    const why = checkAlertResolutionPreconditions(
      {
        action: 'restore_auto',
        reason: 'restoring the automatic plan now that Router has a fresh result',
        confidence: 0.6,
        rejected: [],
      },
      { code: 'plan_degraded', restoreOption: null },
      null,
      noCandidates,
      timeZone,
    );
    assert.match(why ?? '', /restoreOption/);
  });

  it('restore_auto is accepted when a verified restoreOption exists', () => {
    const why = checkAlertResolutionPreconditions(
      {
        action: 'restore_auto',
        reason: 'restoring the automatic plan now that Router has a fresh result',
        confidence: 0.6,
        rejected: [],
      },
      { code: 'plan_degraded', restoreOption: { engineer_id: 'eng-1', reject_request_ids: [] } },
      null,
      noCandidates,
      timeZone,
    );
    assert.equal(why, null);
  });
});
