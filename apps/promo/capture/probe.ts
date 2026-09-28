/**
 * A dry run of the risky beats, without filming any of them.
 *
 * The reel's later scenes depend on states the stand has to actually be in: the alert
 * actions only light up on a live session, the AI explanation only exists on a plan the
 * quality model does not call green, and the policy comparison starts empty until it is
 * asked for. Finding that out from a finished take costs a quarter of an hour, so this
 * opens the same pages, reports what it sees and leaves.
 *
 * Run: node capture/probe.ts
 */
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { appears } from './lib/act.ts';
import {
  API,
  DISPATCHER_EMAIL,
  deskContext,
  launchArgs,
  seedSession,
  settle,
  signIn,
  WEB,
} from './lib/stand.ts';

const report: string[] = [];
const say = (line: string) => {
  console.log(line);
  report.push(line);
};

/**
 * Does the model actually answer when an alert is handed to it?
 *
 * `?apply=0` asks for a proposal and changes nothing, which is exactly the half of the
 * flow the reel depends on: without an answer there is no ring around a chosen option,
 * and the scene films a press that leads nowhere.
 */
async function probeAiResolve(token: string): Promise<void> {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const list = (await fetch(`${API}/dispatch/alerts`, { headers }).then((r) => r.json())) as {
    alerts?: { id: string; code: string; actions?: unknown[] }[];
  };
  const solvable = list.alerts?.find((alert) => (alert.actions?.length ?? 0) > 0);
  if (!solvable) {
    say('ai-resolve: no alert on the board carries actions');
    return;
  }
  say(`ai-resolve: asking the model about ${solvable.code} (${solvable.id.slice(0, 8)})…`);
  const began = Date.now();
  const res = await fetch(
    `${API}/dispatch/alerts/${encodeURIComponent(solvable.id)}/ai-resolve?apply=0`,
    { method: 'POST', headers, body: JSON.stringify({ operationId: randomUUID() }) },
  );
  const body = await res.text();
  say(
    `ai-resolve: ${res.status} in ${((Date.now() - began) / 1000).toFixed(1)}s -> ${body.slice(0, 300)}`,
  );
}

async function main() {
  const browser = await chromium.launch({ args: launchArgs() });
  const session = await signIn(DISPATCHER_EMAIL, 'dispatcher');
  await probeAiResolve(session.token);
  const context = await deskContext(browser);
  await seedSession(context, 'dispatcher', session);
  const page = await context.newPage();
  page.on('pageerror', (error) => say(`page error: ${error.message}`));
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await settle(page, 3000);

  const start = page.getByRole('button', { name: /Начать рабочий день/ });
  if (await appears(start, 4000)) {
    say('welcome screen is up — starting the day so the rest of the probe has a board');
    await start.first().click();
    await settle(page, 12_000);
  }

  // --- alerts -------------------------------------------------------------
  await page.getByRole('button', { name: 'Алерты', exact: true }).click();
  await settle(page, 3000);
  const cards = await page.locator('button', { hasText: 'Решить с AI' }).count();
  say(`alerts: ${cards} card(s) offering «Решить с AI»`);
  if (cards > 0) {
    const solve = page.getByRole('button', { name: 'Решить с AI' }).first();
    const disabled = await solve.isDisabled();
    say(`alerts: «Решить с AI» disabled = ${disabled}`);
    const others = page.locator('section button:not([aria-label])');
    say(`alerts: ${await others.count()} other buttons in view`);
  }
  const caption = page.getByText(/Решения доступны при подключении/);
  say(`alerts: the "writes are off" caption is ${(await caption.count()) ? 'SHOWN' : 'absent'}`);

  // --- plan metrics -------------------------------------------------------
  await page.getByRole('button', { name: 'План дня', exact: true }).click();
  await settle(page, 2500);
  await page
    .getByRole('button', { name: /Метрики плана/ })
    .first()
    .click();
  say(`metrics: dialog opened = ${await appears(page.locator('#plan-metrics-title'), 8000)}`);
  await settle(page, 6000);
  const explain = page.getByRole('button', { name: 'Объяснить с AI' });
  say(`metrics: AI-explain icon present = ${(await explain.count()) > 0} (yellow/red band only)`);
  const optimise = page.getByRole('button', { name: /Оптимизировать/ });
  say(`metrics: «Оптимизировать» present = ${(await optimise.count()) > 0}`);
  const compare = page.getByRole('button', { name: /Сравнить политики/ });
  say(`metrics: «Сравнить политики» present = ${(await compare.count()) > 0}`);
  const grade = await page
    .locator('#plan-metrics-title')
    .locator('xpath=../..')
    .innerText()
    .catch(() => '');
  say(`metrics text ---\n${grade.slice(0, 900)}\n---`);

  // --- policy comparison --------------------------------------------------
  if (await compare.count()) {
    await compare.first().click();
    await settle(page, 2500);
    say(`policies: page open = ${await appears(page.getByText('Сравнение политик'), 8000)}`);
    const tabs = page.locator('fieldset[aria-label="Вид сравнения"] button');
    say(`policies: ${await tabs.count()} view tabs`);
    const refresh = page.getByRole('button', { name: /Сравнить|Пересчитать/ });
    if (await refresh.count()) {
      say('policies: asking for a comparison…');
      await refresh.first().click();
      const gotIt = await appears(page.getByText(/Базовый|FIFO|Быстрее|Короче/), 95_000);
      say(`policies: comparison filled = ${gotIt}`);
      await settle(page, 2000);
      const empty = page.getByText(/Сравнение ещё не считалось|нет данных/i);
      say(`policies: empty-state still shown = ${(await empty.count()) > 0}`);
    }
    const mapTab = page.getByRole('button', { name: 'Карта', exact: true });
    if (await mapTab.count()) {
      await mapTab.first().click();
      say('policies: map tab clicked, waiting for the simulation…');
      await settle(page, 30_000);
      const err = page.getByText(/не удалось|устарел/i);
      say(`policies: map error shown = ${(await err.count()) > 0}`);
    }
  }

  await page.screenshot({ path: 'out/probe.png' });
  say('screenshot -> out/probe.png');
  await context.close();
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
