import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  type CaseExplanation,
  type ExplainSnapshot,
  explainSelection,
} from '../../src/ai/explain/case-explanation';

/**
 * Pins this server-side port against the web's own `apps/web/src/lib/explanations.ts`:
 * both read `docs/contracts/fixtures/case-explanation.golden.json`, a snapshot plus the
 * exact `CaseExplanation` the web builder produces for it (generated once from the real
 * web function, not hand-typed -- see that fixture's own commit). A behavioural drift
 * between the two builders fails a test here or in the web suite, instead of the two
 * quietly disagreeing about why an assignment happened (task brief for
 * `src/ai/explain/**`: "pin both with one shared golden fixture").
 */
interface GoldenCase {
  readonly name: string;
  readonly requestId: string | null;
  readonly engineerId: string | null;
  readonly expected: CaseExplanation;
}

interface GoldenFixture {
  readonly snapshot: ExplainSnapshot;
  readonly cases: readonly GoldenCase[];
}

function loadFixture(): GoldenFixture {
  // `process.cwd()` rather than `__dirname`: this file is compiled to
  // `dist-test/test/unit/*.js` before it runs (`pnpm test`'s `test:build` step), so a
  // `__dirname`-relative path would need a different depth in source vs. compiled form.
  // Tests always run with cwd = `apps/api` (the workspace root), matching
  // `test/support/env.ts`'s own `resolve(process.cwd(), '../../.env')`.
  const path = resolve(process.cwd(), '../../docs/contracts/fixtures/case-explanation.golden.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as GoldenFixture;
}

describe('case-explanation golden fixture (server side)', () => {
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
      assert.deepEqual(explanation, goldenCase.expected);
    });
  }

  it('the fixture actually carries at least one assigned and one unassigned case', () => {
    assert.ok(fixture.cases.some((item) => item.name === 'assigned'));
    assert.ok(fixture.cases.some((item) => item.name === 'unassigned'));
  });
});

it('explains a verified offline blocker even without solver reason codes', () => {
  const fixture = loadFixture();
  const request = fixture.snapshot.requests[0];
  assert.ok(request);
  const snapshot: ExplainSnapshot = {
    ...fixture.snapshot,
    engineers: fixture.snapshot.engineers.map((engineer) => ({
      ...engineer,
      region: request.region,
      skills: [request.requiredSkill],
      day: { availability: 'offline' },
    })),
  };
  const explanation = explainSelection(snapshot, request, null, null, null);
  assert.ok(explanation);
  assert.match(explanation.influence, /недоступны для назначения/);
  assert.doesNotMatch(explanation.influence, /неизвест|только проверкой/);
});
