/**
 * Why the alert actions are grey.
 *
 * `writesDisabled` in `useDashboard` is four conditions at once, and the alert card only
 * shows the one sentence for all of them. This opens the alerts page, watches the button
 * over half a minute and reports whether it ever comes alive — and what the page looks
 * like at that moment.
 *
 * Run: node capture/probe2.ts
 */
import { chromium } from 'playwright';
import { appears } from './lib/act.ts';
import {
  DISPATCHER_EMAIL,
  deskContext,
  launchArgs,
  seedSession,
  settle,
  signIn,
  WEB,
} from './lib/stand.ts';

async function main() {
  const browser = await chromium.launch({ args: launchArgs() });
  const context = await deskContext(browser);
  await seedSession(context, 'dispatcher', await signIn(DISPATCHER_EMAIL, 'dispatcher'));
  const page = await context.newPage();
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/v1/') && r.status() >= 400) {
      failures.push(`${r.status()} ${r.url().replace(/^.*\/api\/v1/, '')}`);
    }
  });
  page.on('requestfailed', (r) => failures.push(`FAILED ${r.url()}`));
  page.on('pageerror', (error) => console.log('page error:', error.message));

  await page.goto(WEB, { waitUntil: 'networkidle' });
  await settle(page, 4000);
  const start = page.getByRole('button', { name: /Начать рабочий день/ });
  if (await appears(start, 4000)) {
    await start.first().click();
    await settle(page, 14_000);
  }

  await page.getByRole('button', { name: 'Алерты', exact: true }).click();
  await settle(page, 2000);

  const solve = page.getByRole('button', { name: 'Решить с AI' }).first();
  for (let i = 0; i < 18; i += 1) {
    const there = await solve.count();
    const disabled = there ? await solve.isDisabled() : null;
    console.log(`t+${(i * 2.5).toFixed(1)}s  button=${there ? 'yes' : 'no'}  disabled=${disabled}`);
    if (disabled === false) break;
    await page.waitForTimeout(2500);
  }

  console.log('failed API calls:', failures.length ? failures.join(', ') : 'none');

  // sessionStorage is where the hook keeps the recovered day that forces `cached`.
  const stored = await page.evaluate(() =>
    Object.keys(sessionStorage).map((k) => `${k} (${sessionStorage.getItem(k)?.length} chars)`),
  );
  console.log('sessionStorage:', stored.join(' | '));

  await page.screenshot({ path: 'out/probe2.png' });
  await context.close();
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
