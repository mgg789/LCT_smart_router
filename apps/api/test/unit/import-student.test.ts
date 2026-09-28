import assert from 'node:assert/strict';
import { test } from 'node:test';
import fixtures from '../../src/orchestrator/imports/quality-student/feature-fixtures.json';
import {
  importFeatures,
  screenImportStudent,
} from '../../src/orchestrator/imports/quality-student/student';

test('student features match Python training fixtures without including row identity', () => {
  for (const fixture of fixtures) {
    const values = importFeatures(fixture.input);
    assert.equal(values.length, fixture.expected.length);
    values.forEach((value, index) => {
      assert.ok(Math.abs(value - (fixture.expected[index] ?? NaN)) < 1e-10);
    });
  }
});

test('rejected teacher labels and pending human audit cannot enable student warnings', () => {
  assert.equal(
    screenImportStudent({
      address: '@@@ ??? \uFFFD 999',
      windowMinutes: 60,
      hasCoordinates: false,
    }),
    null,
  );
});
