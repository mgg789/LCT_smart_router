import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentEngineerAttendance } from '../../src/api/agent-engineer-view';

describe('agent attendance evidence', () => {
  it('does not confuse planning eligibility with a factual check-in', () => {
    const pending = agentEngineerAttendance({
      lineStatus: 'pending',
      availability: 'online',
      lineStartedAt: null,
    });
    assert.equal(pending.isOnLine, false);
    assert.equal(pending.checkedIn, false);
    assert.equal(pending.label, 'Ожидает выхода на линию');
    assert.equal(pending.planningAvailability, 'online');
  });
  it('requires a check-in timestamp and distinguishes a break from being on line', () => {
    assert.equal(
      agentEngineerAttendance({ lineStatus: 'online', availability: 'online', lineStartedAt: null })
        .isOnLine,
      false,
    );
    assert.equal(
      agentEngineerAttendance({ lineStatus: 'online', availability: 'online', lineStartedAt: 100 })
        .isOnLine,
      true,
    );
    const paused = agentEngineerAttendance({
      lineStatus: 'technical_break',
      availability: 'offline',
      lineStartedAt: 100,
    });
    assert.equal(paused.isOnLine, false);
    assert.equal(paused.checkedIn, true);
    assert.equal(agentEngineerAttendance().isOnLine, false);
  });
});
