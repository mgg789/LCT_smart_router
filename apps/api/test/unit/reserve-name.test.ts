import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reserveDisplayName, reserveNameFor } from '../../src/common/reserve-name';

test('covering crews show the region in Russian', () => {
  assert.equal(reserveDisplayName('Резерв east 3'), 'Резерв Восток 3');
  assert.equal(reserveDisplayName('Резерв southeast 1'), 'Резерв Юго-восток 1');
  assert.equal(reserveDisplayName('Резерв south_central 12'), 'Резерв Юг-центр 12');
  assert.equal(reserveNameFor('east', 3), 'Резерв Восток 3');
  assert.equal(reserveDisplayName('Алексей Волков'), 'Алексей Волков');
  assert.equal(reserveDisplayName('Резерв Восток 3'), 'Резерв Восток 3');
});
