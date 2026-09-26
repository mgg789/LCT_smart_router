import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fitWeatherCandidates,
  validateWeatherCandidates,
  type WeatherLegObservation,
  type WeatherRiskValidation,
} from '../../src/orchestrator/ai/weather-regime-calibration';

function makeLegs(
  kind: 'clear' | 'rain',
  day: string,
  count: number,
  actualSec: number,
): WeatherLegObservation[] {
  return Array.from({ length: count }, () => ({
    region: 'east',
    transport: 'car',
    kind,
    workDate: day,
    actualSec,
    canonicalSec: 100,
  }));
}

test('candidate is frozen at its training cutoff and promotes only on later paired evidence', () => {
  const training = [
    ...makeLegs('clear', '2026-09-01', 8, 100),
    ...makeLegs('clear', '2026-09-02', 8, 100),
    ...makeLegs('rain', '2026-09-01', 8, 118),
    ...makeLegs('rain', '2026-09-02', 8, 118),
  ];
  const [candidate] = fitWeatherCandidates(training);
  assert.ok(candidate);
  assert.equal(candidate.training_cutoff, '2026-09-02');
  assert.equal(candidate.multiplier, 1.18);

  const holdout = [
    ...makeLegs('clear', '2026-09-03', 8, 100),
    ...makeLegs('clear', '2026-09-04', 8, 100),
    ...makeLegs('rain', '2026-09-03', 8, 118),
    ...makeLegs('rain', '2026-09-04', 8, 118),
  ];
  const risks: WeatherRiskValidation[] = Array.from({ length: 20 }, (_, index) => {
    const actualBreach = index % 2 === 0;
    return {
      region: 'east',
      transport: 'car',
      kind: 'rain',
      workDate: index < 10 ? '2026-09-03' : '2026-09-04',
      baselineProbability: 0.5,
      candidateProbability: actualBreach ? 0.8 : 0.2,
      actualBreach,
      candidateVersion: candidate.candidate_version,
    };
  });
  const promoted = validateWeatherCandidates([candidate], holdout, risks);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0]?.multiplier, candidate.multiplier);
  assert.equal(promoted[0]?.validation_version, candidate.candidate_version);
  assert.deepEqual(
    validateWeatherCandidates(
      [candidate],
      holdout,
      risks.map((row) => ({ ...row, workDate: '2026-09-03' })),
    ),
    [],
    'many labels from a single later day are not temporal validation',
  );

  const mismatchedVersion = risks.map((row) => ({
    ...row,
    candidateVersion: 'a-different-frozen-model',
  }));
  assert.deepEqual(validateWeatherCandidates([candidate], holdout, mismatchedVersion), []);

  const firstRisk = risks[0];
  assert.ok(firstRisk);
  const imbalancedRisk = [
    ...Array.from({ length: 100 }, () => ({
      ...firstRisk,
      workDate: '2026-09-03',
      actualBreach: false,
      candidateProbability: 0.4,
    })),
    { ...firstRisk, workDate: '2026-09-04', actualBreach: true, candidateProbability: 0 },
  ];
  assert.deepEqual(
    validateWeatherCandidates([candidate], holdout, imbalancedRisk),
    [],
    'a busy successful day cannot hide worse Brier on the other validation day',
  );
});

test('insufficient forward holdout remains shadow, even when training minimums passed', () => {
  const training = [
    ...makeLegs('clear', '2026-09-01', 8, 100),
    ...makeLegs('clear', '2026-09-02', 8, 100),
    ...makeLegs('rain', '2026-09-01', 8, 118),
    ...makeLegs('rain', '2026-09-02', 8, 118),
  ];
  const candidate = fitWeatherCandidates(training)[0];
  assert.ok(candidate);
  const thinHoldout = [
    ...makeLegs('clear', '2026-09-03', 15, 100),
    ...makeLegs('clear', '2026-09-04', 15, 100),
    ...makeLegs('rain', '2026-09-03', 13, 118),
    ...makeLegs('rain', '2026-09-04', 1, 118),
  ];
  const risks = Array.from({ length: 20 }, (_, index) => ({
    region: 'east',
    transport: 'car' as const,
    kind: 'rain' as const,
    workDate: '2026-09-03',
    baselineProbability: 0.5,
    candidateProbability: index % 2 === 0 ? 0.8 : 0.2,
    actualBreach: index % 2 === 0,
    candidateVersion: candidate.candidate_version,
  }));
  assert.deepEqual(validateWeatherCandidates([candidate], thinHoldout, risks), []);
});

test('training balances days and candidate identity is independent of input order', () => {
  const rows = [
    ...makeLegs('clear', '2026-09-01', 8, 100),
    ...makeLegs('clear', '2026-09-02', 8, 100),
    ...makeLegs('rain', '2026-09-01', 30, 100),
    ...makeLegs('rain', '2026-09-02', 1, 200),
  ];
  const [candidate] = fitWeatherCandidates(rows);
  assert.ok(candidate);
  assert.equal(candidate.multiplier, Number(Math.SQRT2.toFixed(4)));
  assert.equal(
    fitWeatherCandidates([...rows].reverse())[0]?.candidate_version,
    candidate.candidate_version,
  );
});
