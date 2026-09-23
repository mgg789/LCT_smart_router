import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DashboardSnapshot } from '../api/types';
import type { CaseExplanation } from './explanations';
import { explainSelection } from './explanations';

/**
 * Pins this module's output against the server's port in
 * `apps/api/src/ai/explain/case-explanation.ts`.
 *
 * Both suites read the same `docs/contracts/fixtures/case-explanation.golden.json`: a
 * snapshot plus the exact `CaseExplanation` this file produces for it. A behavioural
 * drift between the two builders fails a test here or on the server, instead of quietly
 * diverging (task brief: "pin both with one shared golden fixture").
 */
interface GoldenCase {
  readonly name: string;
  readonly requestId: string | null;
  readonly engineerId: string | null;
  readonly expected: CaseExplanation;
}

interface GoldenFixture {
  readonly snapshot: DashboardSnapshot;
  readonly cases: readonly GoldenCase[];
}

function loadFixture(): GoldenFixture {
  const path = resolve(
    __dirname,
    '../../../../docs/contracts/fixtures/case-explanation.golden.json',
  );
  return JSON.parse(readFileSync(path, 'utf-8')) as GoldenFixture;
}

describe('case-explanation golden fixture (web side)', () => {
  const fixture = loadFixture();

  for (const goldenCase of fixture.cases) {
    it(`matches the pinned output for "${goldenCase.name}"`, () => {
      const snapshot = fixture.snapshot;
      const request = goldenCase.requestId
        ? (snapshot.requests.find((item) => item.id === goldenCase.requestId) ?? null)
        : null;
      const assignment = goldenCase.requestId
        ? (snapshot.plan.plan?.assignments.find(
            (item) => item.requestId === goldenCase.requestId,
          ) ?? null)
        : null;
      const engineer = goldenCase.engineerId
        ? (snapshot.engineers.find((item) => item.id === goldenCase.engineerId) ?? null)
        : (snapshot.engineers.find((item) => item.id === assignment?.engineerId) ?? null);
      const route = engineer
        ? (snapshot.plan.plan?.routes.find((item) => item.engineerId === engineer.id) ?? null)
        : null;

      const explanation = explainSelection(snapshot, request, assignment, engineer, route);
      expect(explanation).toEqual(goldenCase.expected);
    });
  }
});
