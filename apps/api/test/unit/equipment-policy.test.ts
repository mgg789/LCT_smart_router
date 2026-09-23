import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  capProvisionalEquipment,
  equipmentCapacity,
  equipmentTotal,
  equipmentWithSpares,
  morningIssueBasket,
} from '../../src/orchestrator/equipment/equipment-policy';
import {
  DEFAULT_DISPATCHER_SETTINGS,
  dispatcherSettingsPatchSchema,
  mergeDispatcherSettings,
  parseDispatcherSettings,
} from '../../src/orchestrator/settings/dispatcher-settings';

describe('physical equipment capacity', () => {
  it('uses configurable total limits for each transport and its legacy alias', () => {
    const settings = parseDispatcherSettings({ equipmentCapacityWalk: 7 });
    assert.equal(equipmentCapacity('walk', settings), 7);
    assert.equal(equipmentCapacity('transit', settings), 7);
    assert.equal(equipmentCapacity('bike', settings), 12);
    assert.equal(equipmentCapacity('car', settings), 30);
    assert.equal(
      dispatcherSettingsPatchSchema.safeParse({ equipmentCapacityWalk: -1 }).success,
      false,
    );
  });
  it('keeps demand before spares and never fills a ceiling unnecessarily', () => {
    const demand = { equipmentRouter: 3, equipmentSetTopBox: 1, equipmentSmartSpeaker: 0 };
    assert.deepEqual(equipmentWithSpares(demand, 5), { ...demand, equipmentRouter: 4 });
    assert.equal(equipmentTotal(equipmentWithSpares(demand, 30)), 6);
    assert.equal(
      equipmentTotal(
        equipmentWithSpares({ ...demand, equipmentRouter: 0, equipmentSetTopBox: 0 }, 5),
      ),
      0,
    );
    assert.throws(() => equipmentWithSpares(demand, 3), /exceeds/);
    assert.equal(morningIssueBasket(demand, 0, 30), null);
    assert.deepEqual(
      morningIssueBasket(
        { equipmentRouter: 1, equipmentSetTopBox: 0, equipmentSmartSpeaker: 0 },
        1,
        30,
      ),
      { equipmentRouter: 2, equipmentSetTopBox: 0, equipmentSmartSpeaker: 0 },
    );
    assert.equal(equipmentTotal(demand), 4);
  });
  it('caps only provisional baskets and preserves unrelated settings', () => {
    assert.equal(
      equipmentTotal(
        capProvisionalEquipment(
          { equipmentRouter: 4, equipmentSetTopBox: 4, equipmentSmartSpeaker: 4 },
          5,
        ),
      ),
      5,
    );
    const next = mergeDispatcherSettings(DEFAULT_DISPATCHER_SETTINGS, { equipmentCapacityBike: 9 });
    assert.equal(next.equipmentCapacityWalk, 5);
    assert.equal(next.equipmentCapacityBike, 9);
  });
});
