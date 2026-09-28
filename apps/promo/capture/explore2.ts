/**
 * Scouts the two phone surfaces and the request explanation, so the scene scripts
 * are written against the states the stand really produces.
 *
 * Run: node capture/explore2.ts
 */
import { mkdir } from 'node:fs/promises';
import { chromium, type Page } from 'playwright';
import {
  CLIENT_EMAIL,
  DISPATCHER_EMAIL,
  deskContext,
  ENGINEER_EMAIL,
  launchArgs,
  phoneContext,
  seedSession,
  settle,
  signIn,
  WEB,
} from './lib/stand.ts';

const OUT = 'out/explore2';
let step = 0;

async function shot(page: Page, name: string) {
  step += 1;
  await page.screenshot({
    path: `${OUT}/${String(step).padStart(2, '0')}-${name}.jpg`,
    quality: 60,
    type: 'jpeg',
  });
  console.log('  shot', name);
}

async function buttons(page: Page, label: string) {
  const all = await page.getByRole('button').all();
  const names: string[] = [];
  for (const button of all.slice(0, 40)) {
    const text = ((await button.getAttribute('aria-label')) ?? (await button.innerText())).trim();
    if (text) names.push(text.replace(/\s+/g, ' ').slice(0, 44));
  }
  console.log(`  [${label}]`, [...new Set(names)].join(' | '));
}

async function engineerTour(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('engineer phone');
  const context = await phoneContext(browser);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  await page.goto(`${WEB}/engineer`, { waitUntil: 'networkidle' });
  await settle(page, 1500);
  await shot(page, 'eng-login');

  await page.fill('#eng-login-email', ENGINEER_EMAIL);
  const code = page
    .waitForResponse((r) => r.url().includes('/auth/login-code') && r.request().method() === 'POST')
    .then((r) => r.json() as Promise<{ devCode?: string }>);
  await page.getByRole('button', { name: 'Войти' }).click();
  const { devCode } = await code;
  console.log('  engineer code arrived:', Boolean(devCode));
  await page.getByLabel('Цифра 1 из 6').waitFor({ timeout: 15_000 });
  await shot(page, 'eng-code');
  for (const [i, digit] of [...(devCode ?? '')].entries()) {
    await page.getByLabel(`Цифра ${i + 1} из 6`).fill(digit);
    await page.waitForTimeout(120);
  }
  await settle(page, 5000);
  await shot(page, 'eng-after-login');
  await buttons(page, 'engineer');
  console.log('  shift overlay:', await page.getByText('Выйти на смену').count());
  console.log(
    '  go-on-line button:',
    await page.getByRole('button', { name: 'Выйти на линию' }).count(),
  );
  console.log('  start button:', await page.getByRole('button', { name: 'Приступить' }).count());
  return { context, page };
}

async function clientTour(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('client phone');
  const context = await phoneContext(browser);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  await page.goto(`${WEB}/client`, { waitUntil: 'networkidle' });
  await settle(page, 1500);
  await shot(page, 'client-form');
  await buttons(page, 'client');

  const auto = page.getByRole('tab', { name: 'Авто' });
  console.log('  auto tab:', await auto.count());
  await auto.click();
  await settle(page, 900);
  await shot(page, 'client-story');
  const story = page.getByPlaceholder(
    'Расскажите, что у вас случилось, когда к вам приехать, ваше ФИО и email',
  );
  console.log('  story field:', await story.count());
  await story.fill(
    `У нас в офисе на улице Лесная, 7 полностью пропал интернет, встала вся касса. Приехать нужно сегодня как можно скорее, меня зовут Иван Петров, ${CLIENT_EMAIL}`,
  );
  await shot(page, 'client-story-typed');
  const send = page.getByRole('button', { name: 'Отправить рассказ' });
  const interpreted = page
    .waitForResponse((r) => r.url().includes('/client/interpret'), { timeout: 40_000 })
    .catch(() => null);
  await send.click();
  await page.waitForTimeout(1500);
  await shot(page, 'client-trace');
  const response = await interpreted;
  console.log('  interpret status:', response?.status());
  await settle(page, 2500);
  await shot(page, 'client-form-filled');
  const values = await page.evaluate(() => ({
    work: (document.querySelector('select') as HTMLSelectElement | null)?.selectedOptions[0]?.label,
    name: (document.querySelector('#client-name') as HTMLInputElement | null)?.value,
    address: (document.querySelector('#client-address') as HTMLInputElement | null)?.value,
    email: (document.querySelector('#client-email') as HTMLInputElement | null)?.value,
  }));
  console.log('  filled:', JSON.stringify(values));
  return { context, page };
}

async function explainTour(browser: Awaited<ReturnType<typeof chromium.launch>>) {
  console.log('dispatcher request explanation');
  const context = await deskContext(browser);
  await seedSession(context, 'dispatcher', await signIn(DISPATCHER_EMAIL, 'dispatcher'));
  const page = await context.newPage();
  await page.goto(WEB, { waitUntil: 'networkidle' });
  await settle(page, 3000);
  await page.getByRole('button', { name: 'Заявки', exact: true }).click();
  await settle(page, 2200);
  await shot(page, 'requests-table');
  const row = page.locator('[data-request-row], tbody tr, [role="row"]').nth(1);
  if (await row.count()) {
    await row.click({ force: true });
    await settle(page, 2600);
    await shot(page, 'request-detail');
    await buttons(page, 'request-detail');
  }
  console.log('  explain scope:', await page.locator('[data-explain-scope]').count());
  const explain = page.getByRole('button', { name: /AI/ });
  console.log('  AI buttons on detail:', await explain.count());
  return { context, page };
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ args: launchArgs() });
  await engineerTour(browser).catch((e) => console.log('engineer tour failed:', e.message));
  await clientTour(browser).catch((e) => console.log('client tour failed:', e.message));
  await explainTour(browser).catch((e) => console.log('explain tour failed:', e.message));
  await browser.close();
  console.log('explore2 done ->', OUT);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
