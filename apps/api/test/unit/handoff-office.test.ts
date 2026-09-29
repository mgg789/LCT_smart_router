import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isUnconfirmedOfficeMeeting } from '../../src/orchestrator/equipment/handoffs';

const office = { lat: 55.6997977, lon: 37.7725762 };
const open = {
  lat: office.lat,
  lon: office.lon,
  donorConfirmedAt: null,
  receiverConfirmedAt: null,
  completedAt: null,
};

describe('unconfirmed meeting at the office', () => {
  it('is not a frozen field exchange', () => {
    assert.equal(isUnconfirmedOfficeMeeting(open, [office]), true);
  });

  it('stays frozen once either engineer has confirmed or the point is not an office', () => {
    assert.equal(isUnconfirmedOfficeMeeting({ ...open, donorConfirmedAt: 1n }, [office]), false);
    assert.equal(isUnconfirmedOfficeMeeting({ ...open, lat: office.lat + 0.01 }, [office]), false);
    assert.equal(isUnconfirmedOfficeMeeting(open, [{ lat: null, lon: null }]), false);
  });
});
