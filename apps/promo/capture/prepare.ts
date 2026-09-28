/**
 * Puts the stand into the state the reel films.
 *
 * Three of the things the storyboard asks for are not accidents of a given day — they
 * are router capabilities the stand ships with switched off:
 *
 *   - lunch, which is why the engineer's day list has no «Обед» row to scroll past;
 *   - metro, which is the purple leg on the map (a walking engineer riding the
 *     underground instead of walking an hour);
 *   - equipment transfers, which is the blue handoff: two engineers meeting at one
 *     point because one of them is carrying a part the other one needs.
 *
 * All three are real product behaviour behind `PUT /dispatch/router/technical-settings`.
 * Metro and the handoff additionally need work that can only be done by the one engineer
 * who walks, so two requests are appended through the dispatcher's own upload endpoint:
 * one far enough away that the underground beats walking, one asking for a part she does
 * not carry.
 *
 * Nothing here fakes a screen. It configures the product and adds real work, and the
 * router decides the rest — which is why this reports what actually landed in the plan
 * instead of assuming.
 *
 * Order matters. «День заново» re-imports the stand's own dataset, which throws away
 * anything appended before it, so the rewind belongs at the front of this script rather
 * than inside the shoot:
 *
 *   node capture/prepare.ts --restart   rewind the day, configure it, add the work
 *   node capture/run.ts                 film it, welcome screen and all
 *
 * Run: node capture/prepare.ts            configure, add the work, wait for the plan
 *      node capture/prepare.ts --restart  rewind the day first
 *      node capture/prepare.ts --check    report the current state and change nothing
 */
import { randomUUID } from 'node:crypto';
import { API, DISPATCHER_EMAIL, ENGINEER_EMAIL, signIn } from './lib/stand.ts';

const checkOnly = process.argv.includes('--check');
const restart = process.argv.includes('--restart');

/**
 * Flags the storyboard needs on; everything else is sent back exactly as it was read.
 *
 * Equipment is deliberately left off. Switching it on is what would let an equipment
 * handoff happen at all — but on this dataset it also strands every request whose part
 * the assigned engineer is not carrying, and a board with half the day unassigned is not
 * the product working, it is the shoot. The handoff needs a region imported with real
 * equipment stock on the crew; there is no dispatcher endpoint that sets stock on an
 * engineer who already exists, so it is out of reach from here.
 */
const WANTED = {
  lunchesEnabled: true,
  metroEnabled: true,
  equipmentEnabled: false,
  equipmentTransfersEnabled: false,
} as const;

interface TechnicalSettings extends Record<string, unknown> {
  readonly routerContextVersion: string;
}

let token = '';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

interface PlanShape {
  readonly plan?: {
    readonly routes?: readonly {
      readonly engineerId?: string;
      readonly legs?: readonly {
        travelSource?: string;
        segments?: readonly { travelSource?: string }[];
      }[];
      readonly stops?: readonly { kind?: string }[];
    }[];
    readonly unassigned?: readonly unknown[];
  };
  readonly calculating?: boolean;
  readonly geometryDone?: number;
  readonly geometryTotal?: number;
}

/** What the map would actually show, read off the plan the stand is serving. */
function readPlan(plan: PlanShape) {
  const routes = plan.plan?.routes ?? [];
  let metro = 0;
  let handoff = 0;
  let lunch = 0;
  let jobs = 0;
  for (const route of routes) {
    for (const leg of route.legs ?? []) {
      const sources = [leg.travelSource, ...(leg.segments ?? []).map((s) => s.travelSource)];
      if (sources.includes('metro')) metro += 1;
    }
    for (const stop of route.stops ?? []) {
      if (stop.kind === 'handoff') handoff += 1;
      if (stop.kind === 'lunch') lunch += 1;
      if (stop.kind === 'job') jobs += 1;
    }
  }
  return {
    routes: routes.length,
    jobs,
    metro,
    handoff,
    lunch,
    unassigned: plan.plan?.unassigned?.length ?? 0,
    calculating: plan.calculating === true,
    geometry: `${plan.geometryDone ?? 0}/${plan.geometryTotal ?? 0}`,
  };
}

async function describe(label: string): Promise<ReturnType<typeof readPlan>> {
  const shape = readPlan(await call<PlanShape>('/dispatch/plan'));
  console.log(
    `${label}: ${shape.routes} routes, ${shape.jobs} jobs, ${shape.unassigned} unassigned, ` +
      `metro legs ${shape.metro}, handoff stops ${shape.handoff}, lunch stops ${shape.lunch}` +
      `${shape.calculating ? ' (still calculating)' : ''}`,
  );
  return shape;
}

/** Waits for the router to settle, then reports what the plan came back with. */
async function settlePlan(budgetMs = 240_000): Promise<ReturnType<typeof readPlan>> {
  const until = Date.now() + budgetMs;
  let last = readPlan(await call<PlanShape>('/dispatch/plan'));
  while (Date.now() < until) {
    if (!last.calculating && last.routes > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    last = readPlan(await call<PlanShape>('/dispatch/plan'));
  }
  return last;
}

/** A point on an engineer's own route, nudged a street over so it is a separate visit. */
async function nearestStopTo(engineerId: string): Promise<{ lat: number; lon: number }> {
  const plan = await call<{
    plan?: {
      routes?: readonly {
        engineerId?: string;
        stops?: readonly { kind?: string; lat?: number; lon?: number }[];
      }[];
    };
  }>('/dispatch/plan');
  const route = plan.plan?.routes?.find((row) => row.engineerId === engineerId);
  const jobs = (route?.stops ?? []).filter((row) => row.kind === 'job' && row.lat && row.lon);
  const stop = jobs[jobs.length - 1];
  if (!stop?.lat || !stop.lon) return { lat: 55.7411, lon: 37.6862 };
  return { lat: stop.lat + 0.0012, lon: stop.lon + 0.0016 };
}

/**
 * How the dashboard grades the day, reproduced from `domain/planQuality.ts`.
 *
 * The reel needs a day this comes back non-green for, and not to cheat: the button that
 * hands the grade to the assistant is rendered for a yellow or a red band and for nothing
 * else, because a plan with nothing wrong with it has nothing to explain.
 */
function qualityBand(expectedLate: number, share: number): 'green' | 'yellow' | 'red' {
  if (expectedLate < 1 && share < 0.05) return 'green';
  if (expectedLate <= 3 && share < 0.12) return 'yellow';
  return 'red';
}

interface Prediction {
  readonly expectedLate: number;
  readonly share: number;
  readonly band: 'green' | 'yellow' | 'red';
}

/** Runs the dashboard's own 300-day simulation over the applied plan. */
async function predict(): Promise<Prediction | null> {
  const plan = await call<{
    appliedResult?: { inputHash?: string; routerContextVersion?: string };
    plan?: {
      routes?: readonly {
        engineerId?: string;
        stops?: readonly { kind?: string; requestId?: string }[];
      }[];
    };
  }>('/dispatch/plan');
  const applied = plan.appliedResult;
  if (!applied?.inputHash || !applied.routerContextVersion) return null;
  const routes: Record<string, string[]> = {};
  for (const route of plan.plan?.routes ?? []) {
    if (!route.engineerId) continue;
    routes[route.engineerId] = (route.stops ?? [])
      .filter((stop) => stop.kind === 'job' && stop.requestId)
      .map((stop) => stop.requestId as string);
  }
  // The simulation is refused while the router is still settling on the input it is
  // asked about, so a first refusal is a "not yet" rather than an answer.
  type Answer = { plan?: { expected_late?: number; expected_late_share?: number } };
  let answer: Answer | null = null;
  for (let attempt = 0; attempt < 4 && !answer; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 6000));
    answer = await call<Answer>('/dispatch/predictions/situation', {
      method: 'POST',
      body: JSON.stringify({
        inputHash: applied.inputHash,
        routerContextVersion: applied.routerContextVersion,
        routes,
        simulations: 300,
      }),
    }).catch((error: unknown) => {
      if (attempt === 3) console.log(`  the simulation refused: ${String(error).slice(0, 180)}`);
      return null;
    });
  }
  if (!answer?.plan) return null;
  const expectedLate = answer.plan.expected_late ?? 0;
  const share = answer.plan.expected_late_share ?? 0;
  return { expectedLate, share, band: qualityBand(expectedLate, share) };
}

/**
 * Narrows the grace the plan is allowed past a window, until the day is honestly graded.
 *
 * `windowLatenessToleranceSec` is how many seconds past a promised window still count as
 * on time. The stand ships with ten minutes of it, which on this dataset is enough for
 * the quality model to call every day perfect — and a reel that shows a perfect day has
 * nothing to show the assistant explaining. Tightening it is not a trick: it is the
 * dispatcher saying that a minute late is late, which is the setting the explanation is
 * there to serve.
 */
async function setTolerance(seconds: number): Promise<boolean> {
  const settings = await call<TechnicalSettings>('/dispatch/router/technical-settings');
  if (settings.windowLatenessToleranceSec === seconds) return false;
  const { routerContextVersion, ...rest } = settings;
  await call('/dispatch/router/technical-settings', {
    method: 'PUT',
    body: JSON.stringify({
      ...rest,
      windowLatenessToleranceSec: seconds,
      operationId: randomUUID(),
      expectedContextVersion: routerContextVersion,
    }),
  });
  console.log(`  ${seconds}s of grace past a promised window now counts as on time`);
  await settlePlan();
  await waitForContext();
  return true;
}

/**
 * Waits until the applied plan was actually built under the settings now in force.
 *
 * Changing a technical setting mints a new router context, and every read that quotes a
 * plan — the robustness simulation above, the policy comparison — refuses an input built
 * under the old one. The refusal is correct, so the answer is to wait for the rebuild
 * rather than to ask again with a stale hash.
 */
async function waitForContext(budgetMs = 180_000): Promise<void> {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    const [settings, plan] = await Promise.all([
      call<TechnicalSettings>('/dispatch/router/technical-settings'),
      call<{ appliedResult?: { routerContextVersion?: string } }>('/dispatch/plan'),
    ]);
    if (settings.routerContextVersion === plan.appliedResult?.routerContextVersion) return;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  console.log('  the plan is still on the previous router context');
}

function report(where: string, seen: Prediction | null): void {
  console.log(
    seen
      ? `${where}: ${seen.band} (${seen.expectedLate} late, ${(seen.share * 100).toFixed(1)}%)`
      : `${where}: the simulation did not answer`,
  );
}

/**
 * Leaves the day in a state the quality model has an opinion about.
 *
 * The dial is `windowLatenessToleranceSec`: how long past a promised window a visit may
 * still finish and count as on time. It reads like a scoring threshold, but it is a
 * planning one — the wider the grace, the more tightly the solver is allowed to pack the
 * day, and the more visits actually run late. So the scan runs upward, and stops at the
 * first setting the model calls yellow.
 *
 * Yellow is the state the reel needs and the state the product is most itself in: a plan
 * that holds, with a couple of visits worth watching, and an assistant that will say
 * which ones and why. Green has nothing to explain and hides the button that explains it;
 * red is a day in trouble, which is the wrong thing to open a promo's metrics on.
 */
const GRACE_LADDER = [600, 750, 900, 1050, 1200] as const;

async function tightenUntilGraded(): Promise<void> {
  let seen = await predict();
  report('plan grade', seen);
  if (seen?.band === 'yellow') return;

  const tried: { tolerance: number; seen: Prediction }[] = [];
  for (const tolerance of GRACE_LADDER) {
    if (await setTolerance(tolerance)) {
      seen = await predict();
    }
    report(`  at ${tolerance}s of grace`, seen);
    if (!seen) continue;
    tried.push({ tolerance, seen });
    if (seen.band === 'yellow') {
      report('plan grade, settled', seen);
      return;
    }
  }

  // No setting came out yellow. Take the one that came closest to the middle of the
  // yellow band, so the day is at least as interesting as this dataset allows.
  const best = tried.sort(
    (a, b) => Math.abs(a.seen.share - 0.085) - Math.abs(b.seen.share - 0.085),
  )[0];
  if (!best) {
    console.log('  the simulation never answered — the grade is whatever it is');
    return;
  }
  await setTolerance(best.tolerance);
  seen = await predict();
  report('plan grade, settled', seen);
  if (seen?.band === 'green') {
    console.log('  the day stays green — the AI explanation will have nothing to explain');
  }
}

interface EngineerRow {
  readonly id: string;
  readonly displayName: string;
  readonly transportType?: string;
  readonly transitEligible?: boolean;
  readonly equipmentStock?: Record<string, number>;
}

/**
 * Gives the filmed engineer her login address back after a rewind.
 *
 * The rewind rebuilds every engineer row, and a rebuilt row has no account on it. The
 * engineer app then has no day to show, and the shift scene has nothing to film.
 */
async function relinkEngineer(): Promise<void> {
  const list = await call<{ engineers?: { id: string; email: string | null }[] }>(
    '/dispatch/engineers',
  );
  if (list.engineers?.some((row) => row.email === ENGINEER_EMAIL)) {
    console.log('  the engineer profile already carries its address');
    return;
  }
  const free = list.engineers?.find((row) => row.email === null);
  if (!free) {
    console.log('  no free engineer profile — the shift scene may have nothing to film');
    return;
  }
  await call('/dispatch/engineers/link-account', {
    method: 'POST',
    body: JSON.stringify({
      operationId: randomUUID(),
      engineerId: free.id,
      email: ENGINEER_EMAIL,
    }),
  });
  console.log(`  linked ${ENGINEER_EMAIL} to an engineer profile`);
}

async function main() {
  token = (await signIn(DISPATCHER_EMAIL, 'dispatcher')).token;

  if (restart && !checkOnly) {
    console.log('rewinding the day…');
    await call('/dispatch/data/restart-demo', {
      method: 'POST',
      body: JSON.stringify({ operationId: randomUUID() }),
    });
    await new Promise((resolve) => setTimeout(resolve, 9000));
    // The rewind mints a new session for the old one, so sign in again before asking
    // anything else of the stand.
    token = (await signIn(DISPATCHER_EMAIL, 'dispatcher')).token;
    await relinkEngineer();
  }

  const settings = await call<TechnicalSettings>('/dispatch/router/technical-settings');
  const already = Object.entries(WANTED).every(([key, value]) => settings[key] === value);
  console.log(
    'router flags:',
    Object.keys(WANTED)
      .map((key) => `${key}=${String(settings[key])}`)
      .join(' '),
  );

  const engineers = (await call<{ engineers?: EngineerRow[] }>('/dispatch/engineers')).engineers;
  const walker = engineers?.find((e) => e.transportType === 'walk');
  console.log(
    'crew:',
    engineers?.map((e) => `${e.displayName} [${e.transportType}]`).join(', ') ?? 'none',
  );
  if (!walker) {
    console.log('  no walking engineer on this stand — metro and the handoff cannot be planned');
  } else {
    console.log(`  the underground and the handoff would go to ${walker.displayName}`);
  }

  const before = await describe('plan now');
  if (checkOnly) {
    const seen = await predict();
    console.log(
      seen
        ? `plan grade: ${seen.band} (${seen.expectedLate} late, ${(seen.share * 100).toFixed(1)}%)`
        : 'plan grade: the simulation did not answer',
    );
    return;
  }

  if (already) {
    console.log('router flags are already set the way the reel needs them');
  } else {
    const { routerContextVersion, ...rest } = settings;
    await call('/dispatch/router/technical-settings', {
      method: 'PUT',
      body: JSON.stringify({
        ...rest,
        ...WANTED,
        operationId: randomUUID(),
        expectedContextVersion: routerContextVersion,
      }),
    });
    console.log('router flags updated: lunch, metro, equipment and transfers are on');
  }

  // The work that gives the map its purple leg and its blue meeting. Both are pinned to
  // public transport, which on this crew means exactly one engineer — the one who walks,
  // and who carries no equipment at all.
  const day = 1790542800; // midnight of the stand's logical day, read off its own requests
  const shared = {
    serviceDurationSec: 1800,
    priority: 'normal' as const,
    requiredSkill: 'local' as const,
    requiredTransport: 'transit' as const,
    workType: 'cable_work',
    workCategory: 'service' as const,
  };

  async function append(
    label: string,
    requests: readonly Record<string, unknown>[],
  ): Promise<void> {
    await call('/dispatch/data/upload', {
      method: 'POST',
      body: JSON.stringify({
        operationId: randomUUID(),
        schemaVersion: '1.0',
        mode: 'append_requests',
        region: 'east',
        sourceVersion: `promo-${label}-${Date.now().toString().slice(-7)}`,
        requests,
      }),
    });
    console.log(`appended ${requests.length} request(s): ${label}`);
  }

  if (walker && before.metro === 0) {
    const stamp = Date.now().toString().slice(-7);
    await append('a visit right across town, too far to walk', [
      {
        ...shared,
        externalId: `promo-metro-${stamp}`,
        addressText: 'Город Москва, пер.Маяковского, д. 4',
        lat: 55.7397743,
        lon: 37.6599082,
        windowStartAt: day + 12 * 3600,
        windowEndAt: day + 17 * 3600,
      },
    ]);
  }

  console.log('waiting for the router…');
  let after = await settlePlan();

  /**
   * A meeting has to be worth making.
   *
   * The rescue pass only inserts a handoff when the detour actually fits, so a job
   * dropped somewhere across the region is refused and simply stays unassigned. Asking
   * again next to a stop the walking engineer already has, with a window open most of
   * the day, is what gives the solver room to say yes.
   */
  if (WANTED.equipmentTransfersEnabled && walker && after.handoff === 0) {
    const near = await nearestStopTo(walker.id);
    const stamp = Date.now().toString().slice(-7);
    await append('a part she is not carrying, next to a stop she already has', [
      {
        ...shared,
        externalId: `promo-handoff-${stamp}`,
        addressText: 'Город Москва, ул.Госпитальный Вал, д. 5',
        lat: near.lat,
        lon: near.lon,
        serviceDurationSec: 1200,
        requiredEquipment: 'smart_speaker',
        windowStartAt: day + 10 * 3600,
        windowEndAt: day + 20 * 3600,
      },
    ]);
    console.log('waiting for the router…');
    after = await settlePlan();
  }
  console.log(
    `plan after: ${after.routes} routes, ${after.jobs} jobs, ${after.unassigned} unassigned, ` +
      `metro legs ${after.metro}, handoff stops ${after.handoff}, lunch stops ${after.lunch}`,
  );
  for (const [what, count] of [
    ['a metro leg (purple)', after.metro],
    ['an equipment handoff (blue)', after.handoff],
    ['a lunch stop', after.lunch],
  ] as const) {
    console.log(`  ${count > 0 ? 'OK  ' : 'MISS'} ${what}`);
  }

  await tightenUntilGraded();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
