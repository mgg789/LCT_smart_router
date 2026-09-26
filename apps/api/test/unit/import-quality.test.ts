import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeImportQuality,
  type ImportQualityRequest,
} from '../../src/orchestrator/imports/import-quality';

function request(externalId: string, serviceDurationSec = 1800): ImportQualityRequest {
  return {
    externalId,
    addressText: `ул. Тестовая, ${externalId}`,
    lat: 55.75,
    lon: 37.61,
    serviceDurationSec,
    windowStartAt: 1_789_459_200,
    windowEndAt: 1_789_466_400,
    district: 'Центральный',
  };
}

describe('analyzeImportQuality', () => {
  it('is silent for a consistent batch and stable across repeated runs', () => {
    const batch = [request('r1'), request('r2'), request('r3'), request('r4')];
    assert.deepEqual(analyzeImportQuality(batch), []);
    assert.deepEqual(analyzeImportQuality(batch), analyzeImportQuality(batch));
  });

  it('reports advisory outliers and known format findings without changing rows', () => {
    const batch = [
      request('r1'),
      request('r2'),
      request('r3'),
      {
        ...request('r4', 86_400),
        addressText: 'г.Город Москва, Тестовая',
        district: '',
        windowEndAt: 1_789_459_200 + 23 * 3_600,
      },
      { ...request('r5'), addressText: 'одинаковый адрес' },
      { ...request('r6'), addressText: 'одинаковый адрес' },
    ];
    const original = structuredClone(batch);
    const findings = analyzeImportQuality(batch);
    assert.deepEqual(batch, original);
    assert.ok(findings.some((finding) => finding.code === 'all_day_windows'));
    assert.ok(findings.some((finding) => finding.code === 'missing_district'));
    assert.ok(findings.some((finding) => finding.code === 'unusual_address_prefix'));
    assert.ok(findings.some((finding) => finding.code === 'duplicate_addresses'));
    assert.ok(findings.some((finding) => finding.code === 'service_duration_outliers'));
  });
});
