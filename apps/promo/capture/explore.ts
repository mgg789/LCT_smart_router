/**
 * Walks the dispatcher stand and photographs every state the reel intends to film,
 * so the scene scripts are written against what is really on screen.
 *
 * Run: node capture/explore.ts
 */
import { mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import {
  DISPATCHER_EMAIL,
  deskContext,
  forgetWorkdayStart,
  launchArgs,
  seedSession,
  settle,
  signIn,
  WEB,
} from './lib/stand.ts';

const OUT = 'out/explore';
let step = 0;

async function shot(page: Page, name: string) {
  step += 1;
  const file = `${OUT}/${String(step).padStart(2, '0')}-${name}.jpg`;
  await page.screenshot({ path: file, quality: 62, type: 'jpeg', scale: 'css' });
  console.log('  shot', file);
}

async function describe(page: Page, label: string) {
  const buttons = await page.getByRole('button').all();
  const names: string[] = [];
  for (const button of buttons.slice(0, 60)) {
    const text = ((await button.getAttribute('aria-label')) ?? (await button.innerText())).trim();
    if (text) names.push(text.replace(/\s+/g, ' ').slice(0, 40));
  }
  console.log(`  [${label}] buttons:`, [...new Set(names)].join(' | '));
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ args: launchArgs() });
  const context = await deskContext(browser);
  const session = await signIn(DISPATCHER_EMAIL, 'dispatcher');
  await seedSession(context, 'dispatcher', session);
  await forgetWorkdayStart(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('  page error:', error.message));

  console.log('opening the dashboard');
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await settle(page, 2500);
  await shot(page, 'entry');
  await describe(page, 'entry');

  const start = page.getByRole('button', {
    name: /Начать рабочий день|Загружаем|Запускаем|Повторить/,
  });
  if (await start.count()) {
    console.log('welcome screen is up:', (await start.first().innerText()).trim());
    await shot(page, 'welcome');
    await start.first().click();
    await settle(page, 6000);
    await shot(page, 'after-start');
  }

  await describe(page, 'dashboard');
  console.log('  MAIN artboard present:', await page.locator('[data-name="MAIN"]').count());
  console.log('  map ready:', await page.locator('[data-map-ready]').count());

  // Sidebar tour.
  for (const nav of ['Заявки', 'Инженеры', 'Алерты', 'Политики', 'AI', 'План дня']) {
    const button = page.getByRole('button', { name: nav, exact: true });
    if (!(await button.count())) {
      console.log('  nav missing:', nav);
      continue;
    }
    await button.first().click();
    await settle(page, 2200);
    await shot(page, `nav-${nav.replace(/\s+/g, '-').toLowerCase()}`);
    if (nav === 'Алерты') await describe(page, 'alerts');
    if (nav === 'AI') await describe(page, 'ai');
  }

  // Header surfaces.
  const metrics = page.getByRole('button', { name: /Метрики плана/ });
  if (await metrics.count()) {
    await metrics.first().click();
    await settle(page, 4000);
    await shot(page, 'metrics-modal');
    await describe(page, 'metrics');
    const explain = page.getByRole('button', { name: /Объяснить с AI/ });
    console.log('  AI explain available:', await explain.count());
    if (await explain.count()) {
      await explain.first().click();
      await settle(page, 6000);
      await shot(page, 'metrics-ai');
    }
    await page.keyboard.press('Escape');
    await settle(page, 900);
  }

  const policy = page.getByRole('button', { name: /Политика:/ });
  if (await policy.count()) {
    await policy.first().click();
    await settle(page, 1600);
    await shot(page, 'policy-panel');
    await describe(page, 'policy');
    await page.keyboard.press('Escape');
    await settle(page, 700);
  }

  const user = page.getByRole('button', { name: 'Меню пользователя' });
  if (await user.count()) {
    await user.first().click();
    await settle(page, 1200);
    await shot(page, 'user-menu');
    await describe(page, 'user-menu');
    await page.keyboard.press('Escape');
  }

  const bell = page.getByRole('button', { name: /уведомлени/i });
  if (await bell.count()) {
    await bell.first().click();
    await settle(page, 1500);
    await shot(page, 'notifications');
  }

  await browser.close();
  console.log('explore done ->', OUT);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
