/**
 * Films the running stand.
 *
 * Every shot in the reel comes from here: the real dispatcher dashboard, the real
 * engineer app and the real client app, driven through the storyboard by a cursor that
 * actually moves and a keyboard that actually types. Nothing is redrawn later — the
 * motion design in `src/` only moves, cuts and frames what these takes contain.
 *
 * Several scenes are deliberately filmed as one unbroken take, because the storyboard
 * asks for moves the edit cannot fake: zooming into the map that is already on screen,
 * pressing «Подробнее» and pulling back to the panel it opened, walking from the policy
 * pill to the metrics dialog to the assistant's explanation. A cut in the middle of any
 * of those reads as a different screen, so the camera work happens in `src/` over a
 * single continuous stretch of footage, and the job here is to produce that stretch.
 *
 * Prepare the stand first — `node capture/prepare.ts --restart` — then:
 *
 * Run everything:      node capture/run.ts
 * Run part of it:      node capture/run.ts --only=client,replan
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { appears, scrollSmooth, typeHuman, watchLoginCode } from './lib/act.ts';
import { holdRoutes, playRouteChange, stageMapReveal } from './lib/mapStage.ts';
import { Pointer } from './lib/pointer.ts';
import { Recorder, type SceneMeta } from './lib/recorder.ts';
import {
  API,
  CLIENT_EMAIL,
  DESK_VIEWPORT,
  DISPATCHER_EMAIL,
  deskContext,
  ENGINEER_EMAIL,
  forgetWorkdayStart,
  hideCaptureFocus,
  hideCodeCellFocus,
  launchArgs,
  PHONE_VIEWPORT,
  phoneContext,
  seedSession,
  settle,
  signIn,
  WEB,
} from './lib/stand.ts';

const RAW = 'out/raw';
/** Present while a capture is running, so an encode cannot read frames mid-rewrite. */
const LOCK = `${RAW}/.capturing`;

const STORY = [
  'У нас в офисе полностью пропал интернет, не работают кассы и телефония.',
  ' Адрес: Москва, улица Лесная, 7. Меня зовут Иван Петров, почта ',
  CLIENT_EMAIL,
  '. Нужна помощь срочно, сегодня.',
].join('');

const CLIENT_ADDRESS = 'Москва, улица Лесная, 7';
/** The strategies the header offers, in the order the reel would rather show them. */
const POLICY_CHOICES = [
  'Бережнее к окнам',
  'Ровнее загрузка',
  'Быстрее до клиента',
  'Короче пробег',
] as const;

/**
 * Strategies that tend to leave a day the quality model will not call green.
 *
 * The assistant's explanation of a plan's grade only exists where there is something to
 * explain: the icon that opens it is rendered for a yellow or red band and for nothing
 * else. A day that comes out perfect has no explanation to show, so the scene asks for a
 * strategy that trades punctuality for something else before it films the dialog.
 */
const RISKY_POLICIES = ['Короче пробег', 'Ровнее загрузка'] as const;

const AI_QUESTION = 'Что произошло с планом?';

const only = process.argv
  .find((arg) => arg.startsWith('--only='))
  ?.slice('--only='.length)
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

const captured: SceneMeta[] = [];

function wanted(name: string): boolean {
  return !only || only.includes(name);
}

/** A point given as a fraction of a viewport, so a resolution change cannot strand it. */
function at(
  viewport: { width: number; height: number },
  fx: number,
  fy: number,
): { x: number; y: number } {
  return { x: Math.round(viewport.width * fx), y: Math.round(viewport.height * fy) };
}

/** Starts a take on a page, handing the script a recorder and a cursor. */
async function take(
  page: Page,
  scene: string,
  viewport: { width: number; height: number },
  start: { x: number; y: number },
) {
  const recorder = new Recorder(page, scene, RAW, viewport);
  await recorder.start();
  const pointer = new Pointer(page, recorder, start);
  await page.mouse.move(start.x, start.y);
  return { recorder, pointer };
}

async function finish(recorder: Recorder): Promise<void> {
  const meta = await recorder.stop();
  captured.push(meta);
  console.log(
    `  filmed ${meta.scene}: ${meta.duration.toFixed(1)}s, ${meta.frames.length} frames, ` +
      `marks ${Object.keys(meta.marks).join('/')}`,
  );
}

/**
 * Waits for a control to become pressable, not merely present.
 *
 * The dashboard turns every write off while a snapshot is in flight, and an alert card
 * renders its actions greyed rather than hiding them. Clicking one of those does nothing
 * at all, and the take ends up showing a dispatcher pressing a dead button — which is
 * exactly what the first pass of this reel did.
 */
async function pressable(page: Page, locator: ReturnType<Page['locator']>, budgetMs = 45_000) {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if ((await locator.count()) > 0 && !(await locator.first().isDisabled())) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// The dispatcher page lives across several scenes: the day it starts is the day
// the client request lands in, the alerts resolve in and the shift closes on.
// ---------------------------------------------------------------------------

let deskCtx: BrowserContext | null = null;
let desk: Page | null = null;

async function openDesk(browser: Browser): Promise<Page> {
  if (desk) return desk;
  deskCtx = await deskContext(browser);
  await hideCaptureFocus(deskCtx);
  await seedSession(deskCtx, 'dispatcher', await signIn(DISPATCHER_EMAIL, 'dispatcher'));
  await forgetWorkdayStart(deskCtx);
  desk = await deskCtx.newPage();
  desk.on('pageerror', (error) => console.log('  desk page error:', error.message));
  await desk.goto(WEB, { waitUntil: 'networkidle' });
  await settle(desk, 2600);
  return desk;
}

/**
 * Keeps the assistant's transcript pinned to the top while it streams.
 *
 * The product calls `scrollTo` the bottom on every token. Replacing that on the
 * scroller itself — and repeating it when the text changes — leaves the new answer
 * growing downward through the pane instead of disappearing above it.
 */
async function pinAiTranscript(page: Page): Promise<void> {
  await page.evaluate(() => {
    const field = document.querySelector('textarea[aria-label="Сообщение ассистенту"]');
    const scroller = field?.closest('section')?.querySelector('.overflow-y-auto');
    if (!(scroller instanceof HTMLElement)) return;
    const pin = () => {
      scroller.scrollTop = 0;
    };
    scroller.scrollTo = () => {
      pin();
    };
    pin();
    const observer = new MutationObserver(pin);
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
  });
}

/**
 * Clears the notices stacked in the corner.
 *
 * The toast column is laid over the whole board at `z-[80]`. Its wrapper lets clicks
 * through, but the cards in it do not — and the cards sit in the same corner as the
 * policy panel. A press on a policy option while a notice is peeking lands on the notice,
 * the day never changes strategy, and the scene films a dispatcher choosing nothing. That
 * is exactly what the first two passes of this reel did.
 */
async function dismissToasts(page: Page): Promise<void> {
  const closers = page.locator('[data-toast-close]');
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await closers.count()) === 0) return;
    await closers
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});
    await page.waitForTimeout(220);
  }
}

/**
 * Waits until the router has stopped working.
 *
 * The dashboard refuses a strategy change while a rebuild is in flight — quietly, because
 * the control is not disabled, it simply returns. The customer's emergency starts exactly
 * such a rebuild, so a scene that presses a policy right after it presses nothing at all.
 * The stand's own plan endpoint says when it is done.
 */
async function waitForRouterIdle(budgetMs = 120_000): Promise<boolean> {
  const session = await signIn(DISPATCHER_EMAIL, 'dispatcher');
  const headers = { authorization: `Bearer ${session.token}` };
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    const plan = (await fetch(`${API}/dispatch/plan`, { headers })
      .then((r) => r.json())
      .catch(() => null)) as { calculating?: boolean; routerPhase?: string } | null;
    if (plan && plan.calculating !== true && plan.routerPhase === 'ready') return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  console.log('  the router is still working; pressing on anyway');
  return false;
}

/**
 * Chooses a strategy from the header, and waits for the day to actually be on it.
 *
 * The cursor travels for the picture; the press goes through the element, because the
 * panel puts a tooltip under a hovering pointer and the corner puts notices over it.
 * The pill is the confirmation: it carries the policy the day is running on, and it only
 * says the new name once the rebuild has come back.
 */
async function pressPolicyOption(
  page: Page,
  pointer: Pointer,
  recorder: Recorder | null,
  choice: string,
): Promise<boolean> {
  const option = page.getByRole('button', { name: choice, exact: true });
  if (!(await appears(option, 5000))) return false;
  await pointer.moveOver(option.first(), 700);
  await page.waitForTimeout(240);
  recorder?.notePointer('down', pointer.position.x, pointer.position.y);
  // Dispatched on the element rather than clicked at its coordinates: the notices in the
  // corner sit over this panel, and a real press would land on whichever one is peeking.
  await option.first().dispatchEvent('click');
  recorder?.notePointer('up', pointer.position.x, pointer.position.y);
  await page.keyboard.press('Escape');
  return true;
}

/** Presses a strategy and waits for the pill to say the day is running on it. */
async function pickPolicy(
  page: Page,
  pointer: Pointer,
  recorder: Recorder | null,
  choice: string,
): Promise<boolean> {
  if (!(await pressPolicyOption(page, pointer, recorder, choice))) return false;

  const pill = page.getByRole('button', { name: /Политика:/ });
  const until = Date.now() + 75_000;
  while (Date.now() < until) {
    const text = await pill
      .first()
      .innerText({ timeout: 4000 })
      .catch(() => '');
    if (text.includes(choice)) return true;
    await page.waitForTimeout(2000);
  }
  return false;
}

/**
 * Puts the board back to plain: no engineer chosen, no panel open, on the day view.
 *
 * Scenes share one page, so whatever the last one left open is what the next one opens
 * on. The closing scene in particular has to be filmed on the board the product shows
 * when nothing is selected — column on the left, map across the rest — because that is
 * the picture the reel ends the day with.
 */
async function resetBoard(page: Page): Promise<void> {
  await page.keyboard.press('Escape').catch(() => {});
  // The corner first: a peeking notice sits over the header, and the header is where
  // the next scene is going to press something.
  await dismissToasts(page);
  const closePanel = page.getByRole('button', { name: 'Закрыть панель' });
  if (await closePanel.count()) {
    await closePanel
      .first()
      .click({ timeout: 4000 })
      .catch(() => {});
    await settle(page, 700);
  }
  const bell = page.getByRole('button', { name: 'Скрыть уведомления' });
  if (await bell.count()) {
    await bell
      .first()
      .click({ timeout: 4000 })
      .catch(() => {});
    await settle(page, 600);
  }
  const day = page.getByRole('button', { name: 'План дня', exact: true });
  if (await day.count()) {
    await day
      .first()
      .click({ timeout: 4000 })
      .catch(() => {});
    await settle(page, 1800);
  }
}

/**
 * Puts every engineer except the filmed one on the line.
 *
 * Only one engineer has an app in this shoot; the others would be marked as no-shows a
 * few logical minutes in, and a board where most of the crew never turned up is not the
 * product, it is the shoot. The filmed engineer is left alone, because the reel films
 * him walking on himself.
 *
 * The dispatcher's availability is a forecast rather than a fact of arrival, so a crew
 * with no app drifts back to «не вышел» at the next deadline. On an accelerated day that
 * is only a couple of real minutes, which is why this is called between scenes rather
 * than once at the start.
 */
/**
 * Opens the desk and presses through the welcome screen when it is still there.
 *
 * Scenes filmed on their own (`--only`) find the day not yet started, because pressing
 * «Начать рабочий день» is the opening scene's job.
 */
async function startDay(browser: Browser): Promise<Page> {
  const page = await openDesk(browser);
  const welcome = page.getByRole('button', { name: /Начать рабочий день/ });
  if (await appears(welcome, 4000)) {
    await welcome.first().click();
    await appears(page.locator('[data-name="MAIN"]'), 40_000);
    await settle(page, 2600);
  }
  return page;
}

/**
 * Addresses of today's requests whose building already has an object passport.
 *
 * The demo restore fills passports for all but the first few requests, so which card
 * carries one depends on the plan; the stand is asked instead of guessing.
 */
async function passportAddresses(): Promise<string[]> {
  const session = await signIn(DISPATCHER_EMAIL, 'dispatcher');
  const headers = { authorization: `Bearer ${session.token}` };
  const list = (await fetch(`${API}/dispatch/requests`, { headers })
    .then((r) => r.json())
    .catch(() => null)) as { requests?: { id: string; addressText: string }[] } | null;
  const found: string[] = [];
  for (const request of list?.requests ?? []) {
    const state = (await fetch(
      `${API}/dispatch/requests/${encodeURIComponent(request.id)}/passport`,
      { headers },
    )
      .then((r) => r.json())
      .catch(() => null)) as { passport?: unknown } | null;
    if (state?.passport) found.push(request.addressText);
  }
  return found;
}

async function bringCrewOnLine(): Promise<void> {
  const session = await signIn(DISPATCHER_EMAIL, 'dispatcher');
  const headers = {
    authorization: `Bearer ${session.token}`,
    'content-type': 'application/json',
  };
  const list = (await fetch(`${API}/dispatch/engineers`, { headers }).then((r) => r.json())) as {
    engineers?: { id: string; email: string | null; displayName: string }[];
  };
  for (const engineer of list.engineers ?? []) {
    if (engineer.email === ENGINEER_EMAIL) continue;
    const res = await fetch(`${API}/dispatch/engineers/${engineer.id}/availability`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operationId: randomUUID(), availability: 'online' }),
    });
    console.log(`  ${engineer.displayName} on the line:`, res.ok);
  }
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

/**
 * The shift opens, and the plan draws itself.
 *
 * Filmed as one take from the welcome screen all the way to the finished roads, because
 * the reel pushes into that map without cutting: it is the same board the dispatcher was
 * just looking at, coming closer, not a second shot of a second screen.
 */
async function sceneOpen(browser: Browser): Promise<void> {
  const page = await openDesk(browser);

  const start = page.getByRole('button', {
    name: /Начать рабочий день|Загружаем рабочий день|Повторить загрузку/,
  });
  if (!(await appears(start, 12_000))) {
    console.log('  no welcome screen to film — rewind the day with capture/prepare.ts --restart');
  }

  const { recorder, pointer } = await take(
    page,
    'open',
    DESK_VIEWPORT,
    at(DESK_VIEWPORT, 0.66, 0.74),
  );
  recorder.mark('welcome');
  // Short. The lockup is already on screen when the reel cuts here, so the beat the
  // storyboard wants is the reach for the button, not the wait before it.
  await page.waitForTimeout(850);

  if (await start.count()) {
    await pointer.moveOver(start.first(), 620);
    recorder.mark('cursorOnStart');
    await page.waitForTimeout(180);
    await pointer.press();
    recorder.mark('startPressed');
  }

  await appears(page.locator('[data-name="MAIN"]'), 40_000);
  recorder.mark('dashboard');

  // Points, then dashed chords, then the real roads in three waves. When the map
  // cannot be driven this way, the take falls back to however the product draws it.
  const staged = await stageMapReveal(page, recorder);
  if (!staged) {
    await page.waitForTimeout(2200);
    recorder.mark('points');
    await page.waitForTimeout(9000);
    recorder.mark('roads');
  }
  // The corner notice covers the engineer panel the next shot opens. It has to be
  // gone before that shot, not during it.
  await dismissToasts(page);
  recorder.mark('toastGone');
  await page.waitForTimeout(700);
  await finish(recorder);
  await bringCrewOnLine();
}

/**
 * The crew column, one engineer chosen, and the board the choice opens.
 *
 * Selecting an engineer is not a highlight: the product answers with the pipeline along
 * the bottom and the detail panel down the right. The take holds on that answer long
 * enough for the reel to pull back and show the whole of it.
 */
async function sceneEngineers(browser: Browser): Promise<void> {
  const page = await openDesk(browser);
  await resetBoard(page);
  await dismissToasts(page);
  await page
    .waitForFunction(
      () => {
        const text = document.body.innerText;
        return (
          !text.includes('Пересчитываем маршруты') && !text.includes('Уточняем линии на карте')
        );
      },
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => console.log('  the route toast was still covering the board'));
  const { recorder, pointer } = await take(
    page,
    'engineers',
    DESK_VIEWPORT,
    at(DESK_VIEWPORT, 0.68, 0.42),
  );
  recorder.mark('board');
  await page.waitForTimeout(900);

  const column = page.getByText('Инженеры ·').first();
  if (await appears(column, 4000)) {
    await pointer.moveOver(column, 900);
    recorder.mark('column');
  }
  await page.waitForTimeout(600);

  const volkov = page.getByRole('button', { name: /Алексей Волков/ });
  if (await appears(volkov, 4000)) {
    await pointer.moveOver(volkov.first(), 700);
    recorder.mark('hover');
    await page.waitForTimeout(500);
    await pointer.press();
    recorder.mark('selected');
    // The pipeline drawer and the right panel animate in; the reel pulls back onto them.
    await page.waitForTimeout(1500);
    recorder.mark('panels');
    await page.waitForTimeout(4200);
  }
  await finish(recorder);
}

/** The engineer signs in for real: address, the code from the letter, then the line. */
async function sceneEngineerLogin(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await phoneContext(browser);
  await hideCodeCellFocus(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('  engineer page error:', error.message));
  await page.goto(`${WEB}/engineer`, { waitUntil: 'networkidle' });
  await settle(page, 1600);

  const { recorder, pointer } = await take(
    page,
    'engineer-login',
    PHONE_VIEWPORT,
    at(PHONE_VIEWPORT, 0.5, 0.82),
  );
  recorder.mark('login');
  await page.waitForTimeout(700);

  const email = page.locator('#eng-login-email');
  await pointer.click(email, { travel: 800 });
  await typeHuman(page, ENGINEER_EMAIL, 46);
  recorder.mark('emailTyped');
  await page.waitForTimeout(420);

  const code = watchLoginCode(page);
  await pointer.click(page.getByRole('button', { name: /^Войти$/ }), { travel: 620 });
  recorder.mark('askedForCode');

  const digits = await code;
  await appears(page.getByLabel('Цифра 1 из 6'), 20_000);
  recorder.mark('codeScreen');
  // The beat the storyboard zooms on: the code is on screen, not yet typed.
  await page.waitForTimeout(1500);
  recorder.mark('codeArrived');

  if (digits) {
    await pointer.moveOver(page.getByLabel('Цифра 1 из 6'), 520);
    await pointer.press();
    for (const [index, digit] of [...digits].entries()) {
      await page.getByLabel(`Цифра ${index + 1} из 6`).fill(digit);
      await page.waitForTimeout(135);
    }
    recorder.mark('codeTyped');
  }

  await page.waitForTimeout(3800);
  recorder.mark('signedIn');

  const onLine = page.getByRole('button', { name: 'Выйти на линию' });
  if (await appears(onLine, 9000)) {
    await pointer.click(onLine, { travel: 900, settle: 360 });
    recorder.mark('onShift');
    // The day list is what the press reveals, and it is the first thing the engineer
    // actually sees of his own shift — the reel holds on it rather than moving straight on.
    await page.waitForTimeout(6200);
  } else {
    console.log('  the engineer was already on the line');
  }
  recorder.mark('dayList');
  await page.waitForTimeout(800);

  // The day list and the visit are one take. A second recording here is a cut, and
  // the storyboard opens a card from the screen the engineer just landed on — the first
  // one whose building already has an object passport, because the reel says so over it.
  // «Приступить» stays off camera: the reel holds on the passport, it does not press it.
  const withPassport = await passportAddresses();
  const cards = page.getByRole('button').filter({ hasText: /Город Москва/ });
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  const texts = (await cards.allInnerTexts()).map(flat);
  const index = texts.findIndex((text) => withPassport.some((address) => text.includes(flat(address))));
  const card = cards.nth(Math.max(0, index));
  if (index < 0) console.log('  no visit in the list has an object passport');
  if (await appears(card, 8000)) {
    await pointer.click(card, { travel: 720, settle: 260 });
    recorder.mark('opened');
    if (await appears(page.getByRole('region', { name: 'Паспорт объекта' }), 8000)) {
      await page.waitForTimeout(500);
    } else {
      console.log('  the opened visit shows no object passport');
      await page.waitForTimeout(1800);
    }
    recorder.mark('passport');
    await page.waitForTimeout(3200);
  } else {
    console.log('  the day list had no visit card to open');
  }
  await finish(recorder);
  return { context, page };
}

/**
 * Waits until the first visit can actually be started.
 *
 * The app offers «Приступить» only once the engineer has arrived, which on a stand
 * running the documented demo acceleration takes a few real minutes rather than the
 * logical hour and a half. Filming before then would show a day that cannot begin.
 */
async function waitForStartable(page: Page, budgetMs = 420_000): Promise<boolean> {
  const begin = page.getByRole('button', { name: 'Приступить' });
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    if (await begin.count()) return true;
    await page.waitForTimeout(6000);
    const left = Math.round((until - Date.now()) / 1000);
    if (left % 30 < 7) console.log(`  waiting for the visit to become startable (${left}s left)`);
  }
  return false;
}

/**
 * The first visit is opened, taken and closed, then the day scrolls past lunch.
 *
 * Tapping the card opens the visit itself — map, window, object passport — and it is
 * there that the day actually begins, so that is where «Приступить» is pressed. The
 * visit is also finished, which is not only for the picture: the dispatcher's result of
 * the day counts visits that were really started and really closed, and a day nobody
 * finished anything in closes on a screen full of zeroes.
 */
async function sceneEngineerDay(page: Page): Promise<void> {
  if (!(await waitForStartable(page))) {
    console.log('  the visit never became startable; filming the day as it stands');
  }
  const { recorder, pointer } = await take(
    page,
    'engineer-day',
    PHONE_VIEWPORT,
    at(PHONE_VIEWPORT, 0.5, 0.59),
  );
  recorder.mark('day');
  await page.waitForTimeout(900);

  // Open the first visit.
  const firstCard = page
    .getByRole('button')
    .filter({ hasText: /Город Москва/ })
    .first();
  if (await appears(firstCard, 6000)) {
    await pointer.click(firstCard, { travel: 800, settle: 300 });
    recorder.mark('opened');
    await page.waitForTimeout(2600);
  }

  const begin = page.getByRole('button', { name: 'Приступить' });
  if (await appears(begin, 6000)) {
    await pointer.click(begin.last(), { travel: 850, settle: 340 });
    recorder.mark('started');
    await page.waitForTimeout(3600);
  } else {
    console.log('  no «Приступить» on screen');
  }
  recorder.mark('inProgress');

  await closeVisit(page, pointer, recorder, 'finished');

  const back = page.getByRole('button', { name: 'Назад к списку' });
  if (await appears(back, 4000)) {
    await pointer.click(back.first(), { travel: 900, settle: 260 });
    await page.waitForTimeout(1600);
  }
  recorder.mark('backToList');
  await page.waitForTimeout(700);

  await scrollSmooth(page, 900, 1600, at(PHONE_VIEWPORT, 0.5, 0.59));
  recorder.mark('scrollOne');
  await page.waitForTimeout(800);
  await scrollSmooth(page, 1000, 1800, at(PHONE_VIEWPORT, 0.5, 0.59));
  recorder.mark('lunch');
  await page.waitForTimeout(1400);
  await scrollSmooth(page, 1000, 1800, at(PHONE_VIEWPORT, 0.5, 0.59));
  recorder.mark('scrollEnd');
  await page.waitForTimeout(1500);
  await finish(recorder);
}

/** Presses «Завершить», and answers the confirmation the app puts in front of it. */
async function closeVisit(
  page: Page,
  pointer: Pointer,
  recorder: Recorder,
  mark: string,
): Promise<boolean> {
  const done = page.getByRole('button', { name: 'Завершить', exact: true });
  if (!(await appears(done, 6000))) return false;
  await pointer.click(done.last(), { travel: 800, settle: 320 });
  await page.waitForTimeout(1400);
  // Some work types ask for a word about what was done before they let the visit close.
  const confirm = page.getByRole('button', { name: /Готово|Подтвердить|Завершить визит/ });
  if (await appears(confirm, 3000)) {
    await pointer.click(confirm.first(), { travel: 600, settle: 240 });
    await page.waitForTimeout(1200);
  }
  recorder.mark(mark);
  await page.waitForTimeout(2200);
  return true;
}

/**
 * Works through more of the day off camera, so the closing screen has a day to report.
 *
 * The dispatcher's result of the day is built from what really happened: visits started
 * and finished, with the minutes between them. None of that can be filmed in the minute
 * the reel spends on the engineer, so the rest of it happens here, between takes.
 */
async function workTheDay(page: Page, visits = 2): Promise<void> {
  for (let index = 0; index < visits; index += 1) {
    const back = page.getByRole('button', { name: 'Назад к списку' });
    if (await back.count()) {
      await back
        .first()
        .click({ timeout: 4000 })
        .catch(() => {});
      await page.waitForTimeout(1200);
    }
    const card = page
      .getByRole('button')
      .filter({ hasText: /Город Москва/ })
      .first();
    if (!(await appears(card, 6000))) return;
    await card.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(1800);

    const begin = page.getByRole('button', { name: 'Приступить' });
    if (await appears(begin, 20_000)) {
      await begin
        .last()
        .click({ timeout: 6000 })
        .catch(() => {});
      await page.waitForTimeout(3200);
    }
    const done = page.getByRole('button', { name: 'Завершить', exact: true });
    if (!(await appears(done, 20_000))) {
      console.log(`  visit ${index + 1} could not be finished yet`);
      return;
    }
    await done
      .last()
      .click({ timeout: 6000 })
      .catch(() => {});
    await page.waitForTimeout(1600);
    const confirm = page.getByRole('button', { name: /Готово|Подтвердить|Завершить визит/ });
    if (await appears(confirm, 3000)) {
      await confirm
        .first()
        .click({ timeout: 4000 })
        .catch(() => {});
      await page.waitForTimeout(1400);
    }
    console.log(`  visit ${index + 1} closed`);
    await page.waitForTimeout(1200);
  }
}

/** A phone already signed in, for a scene that does not film the login. */
async function openEngineerPhone(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await phoneContext(browser);
  await hideCodeCellFocus(context);
  await seedSession(context, 'engineer', await signIn(ENGINEER_EMAIL, 'engineer'));
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('  engineer page error:', error.message));
  await page.goto(`${WEB}/engineer`, { waitUntil: 'networkidle' });
  await settle(page, 2600);
  return { context, page };
}

/**
 * The customer describes an outage in their own words and the form fills itself.
 *
 * One take, from the free-text tab to the press that sends the request. The reel never
 * cuts inside it: the storyboard wants the phone to rise and the camera to close in on
 * the same screen as the form appears, and a cut there is exactly the flash the first
 * pass had.
 */
async function sceneClient(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await phoneContext(browser);
  await hideCodeCellFocus(context);
  const page = await context.newPage();
  page.on('pageerror', (error) => console.log('  client page error:', error.message));
  await page.goto(`${WEB}/client`, { waitUntil: 'networkidle' });
  await settle(page, 1600);

  const { recorder, pointer } = await take(
    page,
    'client',
    PHONE_VIEWPORT,
    at(PHONE_VIEWPORT, 0.5, 0.86),
  );
  recorder.mark('form');
  await page.waitForTimeout(700);

  await pointer.click(page.getByRole('tab', { name: 'Авто' }), { travel: 850 });
  recorder.mark('autoTab');
  await page.waitForTimeout(900);

  const story = page.getByPlaceholder(
    'Расскажите, что у вас случилось, когда к вам приехать, ваше ФИО и email',
  );
  await pointer.click(story, { travel: 700 });
  await typeHuman(page, STORY, 26);
  recorder.mark('storyTyped');
  await page.waitForTimeout(600);

  const interpreted = page
    .waitForResponse((r) => r.url().includes('/client/interpret'), { timeout: 45_000 })
    .catch(() => null);
  await pointer.click(page.getByRole('button', { name: 'Отправить рассказ' }), { travel: 620 });
  recorder.mark('sendStory');
  await page.waitForTimeout(1450);
  recorder.mark('traceDone');
  await interpreted;
  await page.waitForTimeout(1600);
  recorder.mark('formFilled');

  // The retelling writes the address as text, but the visit needs a point on the map,
  // and only typing in the field asks the geocoder for one. The street is already
  // there, so the take completes what is missing instead of typing it a second time.
  // Without the city the geocoder's first hit is another town's Lesnaya street, so the
  // city goes in front. On macOS neither `Control+A` nor Home/End move the caret in a
  // field, so the caret is placed through the element and a rewrite clears it there.
  const address = page.locator('#client-address');
  const caretTo = (where: 'start' | 'end') =>
    address.evaluate((element, side) => {
      if (!(element instanceof HTMLInputElement)) return;
      const at = side === 'start' ? 0 : element.value.length;
      element.setSelectionRange(at, at);
    }, where);
  if (await appears(address, 5000)) {
    await pointer.click(address, { travel: 650 });
    const current = (await address.inputValue()).trim();
    if (/Лесн/i.test(current)) {
      if (!/Москв/i.test(current)) {
        await caretTo('start');
        await typeHuman(page, 'Москва, ', 50);
      }
      await caretTo('end');
      if (!/\b7\b/.test(current)) await typeHuman(page, ', 7', 60);
    } else {
      await address.fill('');
      await typeHuman(page, CLIENT_ADDRESS, 34);
    }
    console.log(`  address "${current}" -> "${(await address.inputValue()).trim()}"`);
    recorder.mark('addressTyped');
    const suggestion = page.locator('button').filter({ hasText: /Лесная.*Москва/ }).first();
    let found = await appears(suggestion, 12_000);
    if (!found) {
      // The public geocoder sometimes drops a request; one more keystroke asks again.
      await caretTo('end');
      await typeHuman(page, ' ', 60);
      found = await appears(suggestion, 12_000);
    }
    if (found) {
      await page.waitForTimeout(700);
      await pointer.click(suggestion, { travel: 520 });
      await page.waitForTimeout(1600);
    } else {
      console.log('  no Moscow suggestion for the address');
    }
    recorder.mark('addressPicked');
    await page.waitForTimeout(900);
  }

  const code = watchLoginCode(page, 40_000);
  // The cursor rests on the send button a beat longer than it needs to: this is the last
  // frame of the customer's part of the story, and the reel cuts out of it on the press.
  await pointer.click(page.getByRole('button', { name: /^Отправить$/ }), {
    travel: 700,
    settle: 900,
  });
  recorder.mark('submit');
  await page.waitForTimeout(1800);

  // The form answers a blocked send with one line saying what it still needs.
  const blocked = page.getByText(/Отметьте точку|Укажите|Выберите/);
  if (await blocked.count()) {
    console.log('  the form refused the send:', (await blocked.first().innerText()).trim());
  }

  // The gate is real and has to be passed for the request to reach the board, but the
  // reel has already cut away by now — the storyboard goes straight from the press to
  // the next card.
  if (await appears(page.getByLabel('Цифра 1 из 6'), 20_000)) {
    recorder.mark('gate');
    await page.waitForTimeout(1100);
    const digits = await code;
    if (digits) {
      for (const [index, digit] of [...digits].entries()) {
        await page.getByLabel(`Цифра ${index + 1} из 6`).fill(digit);
        await page.waitForTimeout(140);
      }
      recorder.mark('codeTyped');
    }
  }

  if (await appears(page.getByText('Заявка отправлена'), 30_000)) {
    recorder.mark('sent');
    await page.waitForTimeout(2600);
  }
  await finish(recorder);
  return { context, page };
}

/**
 * The dispatcher's side of the same minute.
 *
 * The customer's emergency lands while this take is already rolling, so the arrival on
 * screen is the arrival that really happened. Rebuilding for it is then a decision the
 * dispatcher makes — a different policy — and that is what produces a delta the panel can
 * show: an automatic rebuild leaves nothing to accept or reject.
 *
 * The stretch the reel actually uses starts at `rebuilt`: the notice of the rebuild
 * arriving as the previous one leaves, the press on «Подробнее», and the panel it opens.
 * All three happen without a cut, so the policy change that causes them is got out of
 * the way first.
 */
async function sceneReplan(browser: Browser, clientRun: Promise<unknown>): Promise<void> {
  const page = await startDay(browser);
  await resetBoard(page);
  const { recorder, pointer } = await take(
    page,
    'replan',
    DESK_VIEWPORT,
    at(DESK_VIEWPORT, 0.62, 0.56),
  );
  recorder.mark('board');
  // The roads stay as they were until the customer's emergency has been planned in, and
  // then the rebuild is drawn as one visible change. It has to be that rebuild and not a
  // later one: the stand's clock runs fast, and a minute on, the crews without an app
  // have drifted to «не вышел» and the next plan is nearly empty.
  const holding = await holdRoutes(page);
  await clientRun;
  recorder.mark('requestSent');

  const toast = page.locator('[data-toast-card]').filter({ hasText: /перестро|Подробнее/ });
  if (await appears(toast, 45_000)) {
    recorder.mark('toast');
    await page.waitForTimeout(1200);
  } else {
    console.log('  no rebuild notice arrived in time');
  }
  if (holding) {
    await dismissToasts(page);
    await pointer.moveTo(DESK_VIEWPORT.width * 0.95, DESK_VIEWPORT.height * 0.94, 700);
    await page.waitForTimeout(400);
    const moved = await playRouteChange(page, recorder);
    console.log(`  route change on the map: ${moved ? 'new roads' : 'same roads'}`);
    await page.waitForTimeout(1800);
  }

  const more = page
    .locator('[data-toast-card]')
    .filter({ has: page.locator('[data-toast-action]') })
    .first()
    .locator('[data-toast-action]')
    .first();

  // Re-plan the day under a different strategy.
  //
  // The choice has to differ from the one the day already runs on: re-selecting the
  // current policy rebuilds nothing, and then there is no difference to show. The pill
  // carries the current name in its text — but only while it is closed, because opening
  // it renames the control to «Выбери свою политику», so the name is read first.
  //
  // And the pick has to be checked rather than assumed. A press that lands on the panel
  // instead of the option leaves the day exactly as it was, the rebuild never happens,
  // and the scene ends up filming a board where nothing is different — which is what the
  // first pass of this take did.
  const policy = page.getByRole('button', { name: /Политика:/ });
  const pillText = () =>
    policy
      .first()
      .innerText({ timeout: 4000 })
      .catch(() => '');

  if (await appears(policy, 6000)) {
    const before = await pillText();
    const choices = POLICY_CHOICES.filter((name) => !before.includes(name));
    console.log(`  current policy "${before.trim()}"`);

    for (const [attempt, choice] of choices.entries()) {
      // Nothing takes while the router is mid-rebuild, and the corner has to be clear
      // before the panel opens over it.
      await waitForRouterIdle();
      await dismissToasts(page);
      await pointer.click(policy.first(), { travel: attempt === 0 ? 1000 : 500, settle: 300 });
      if (attempt === 0) recorder.mark('policyOpen');
      await page.waitForTimeout(1400);
      await pressPolicyOption(page, pointer, recorder, choice);
      recorder.mark('policyPicked');

      // The notice of the rebuild is the success signal, and it is also the thing this
      // scene exists to film. Waiting on the pill instead costs the whole rebuild, and
      // the notice has come and gone by the time the pill catches up.
      console.log(`  asked for "${choice}", waiting for the rebuild notice…`);
      await pointer.moveTo(DESK_VIEWPORT.width * 0.55, DESK_VIEWPORT.height * 0.62, 600);
      if (await appears(more, 100_000)) break;
      console.log(`  "${choice}" left no notice — the pill reads "${(await pillText()).trim()}"`);
    }
  }

  if (!(await appears(more, 20_000))) {
    const cards = await page.locator('[data-toast-card]').allInnerTexts();
    console.log(
      `  no «Подробнее» in the corner. Toasts on screen: ${cards.length ? cards.map((c) => c.replace(/\s+/g, ' ').trim()).join(' | ') : 'none'}`,
    );
  }
  if (await more.count()) {
    recorder.mark('rebuilt');
    // Long enough for the old notice to finish leaving and the new one to settle: that
    // exchange in the corner is the first thing the reel shows of this take.
    await page.waitForTimeout(2000);
    await pointer.moveOver(more, 1100);
    await page.waitForTimeout(340);
    recorder.notePointer('down', pointer.position.x, pointer.position.y);
    await more.click();
    recorder.notePointer('up', pointer.position.x, pointer.position.y);
    recorder.mark('openDiff');
    await page.waitForTimeout(1500);
  } else {
    console.log('  the rebuild left no «Подробнее» to open');
  }

  const card = page.locator('[aria-label="Изменения после перепланирования"]');
  if (await appears(card, 15_000)) {
    recorder.mark('diff');
    await page.waitForTimeout(3400);
    const ok = page.getByRole('button', { name: 'Понятно' });
    if (await ok.count()) {
      await pointer.click(ok.first(), { travel: 800 });
      recorder.mark('diffClosed');
      await page.waitForTimeout(1200);
    }
  } else {
    console.log('  the difference panel did not open');
  }
  await finish(recorder);
}

/**
 * The question put to the assistant, on the assistant's own page.
 *
 * The take opens where the dispatcher is already working, not on the way there: the
 * walk across the rail is not part of this beat, and the notifications panel is not
 * opened at all — its collapse-catcher sits right over the composer, and a send pressed
 * through it goes nowhere.
 */
async function sceneAiChat(browser: Browser): Promise<void> {
  const page = await openDesk(browser);
  await resetBoard(page);
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await settle(page, 2600);

  const composer = page.getByRole('textbox', { name: 'Сообщение ассистенту' });
  if (!(await pressable(page, composer, 30_000))) {
    console.log('  the assistant will not take a message — filming the page as it stands');
  }
  // The pane scrolls itself to the bottom as tokens arrive, which parks the answer
  // above the fold. Pinning the scroller keeps the stream growing down from the top.
  await pinAiTranscript(page);

  const { recorder, pointer } = await take(
    page,
    'ai-chat',
    DESK_VIEWPORT,
    at(DESK_VIEWPORT, 0.52, 0.72),
  );
  recorder.mark('chat');
  await page.waitForTimeout(900);

  await pointer.click(composer, { travel: 900 });
  await typeHuman(page, AI_QUESTION, 44);
  recorder.mark('asked');
  await page.waitForTimeout(520);

  const send = page.getByRole('button', { name: 'Отправить' }).first();
  if (await pressable(page, send, 15_000)) {
    await pointer.click(send, { travel: 520, settle: 300 });
    recorder.mark('sent');
  } else {
    console.log('  the send button never came alive');
  }

  // The question in the transcript, and the assistant already answering into it. The
  // reel does not wait for the answer — it shows that one is being written.
  await page.waitForTimeout(2600);
  recorder.mark('streaming');
  await page.waitForTimeout(4600);
  recorder.mark('streamMid');
  await page.waitForTimeout(1200);
  await finish(recorder);
}

/**
 * An alert closed by the assistant.
 *
 * The page is opened and the actions are given time to come alive before the take
 * starts. The dashboard greys every write while a snapshot is in flight, and an alert
 * card renders its buttons disabled rather than hiding them, so a take that starts too
 * early films a dispatcher pressing something dead.
 */
async function sceneAlertSolve(browser: Browser): Promise<void> {
  const page = await openDesk(browser);
  await resetBoard(page);
  await page.getByRole('button', { name: 'Алерты', exact: true }).click();
  await settle(page, 2600);

  const solve = page.getByRole('button', { name: 'Решить с AI' });
  if (!(await pressable(page, solve, 60_000))) {
    console.log('  no alert offers a live «Решить с AI» — filming the page as it stands');
  }
  // The card that is about to be solved, by its own id: the list re-sorts as the day
  // moves, so "the first card" is not the same card a minute later.
  const target = page.locator('[data-alert-id]').first();
  const targetId = await target.getAttribute('data-alert-id').catch(() => null);
  console.log(`  solving alert ${targetId ?? 'unknown'}`);

  const { recorder, pointer } = await take(
    page,
    'alert-solve',
    DESK_VIEWPORT,
    at(DESK_VIEWPORT, 0.62, 0.66),
  );
  recorder.mark('alerts');
  await page.waitForTimeout(900);

  if (await solve.count()) {
    // What the model actually answered, so a take that films nothing says why.
    const answered = page
      .waitForResponse((r) => r.url().includes('/ai-resolve'), { timeout: 90_000 })
      .then(async (r) => `${r.status()} ${(await r.text()).slice(0, 200)}`)
      .catch(() => 'no answer');

    await pointer.moveOver(solve.first(), 900);
    recorder.mark('hover');
    // The card explains an action to a pointer that rests on it for 700 ms; the reel
    // shows that explanation arriving before the press.
    await page.waitForTimeout(1250);
    await pointer.press();
    recorder.mark('solvePressed');

    // The assistant's choice is announced by a gradient ring around the option it picked,
    // and the card leaves a couple of seconds later. Both are the product's own
    // animations; the take waits for them rather than counting on a duration.
    //
    // But it waits on the answer, not on the clock: a stand without System one refuses in
    // milliseconds, and ninety seconds of a board doing nothing is ninety seconds the edit
    // then has to race past.
    const verdict = await answered;
    const refused = verdict.includes('SERVICE_NOT_CONFIGURED') || verdict === 'no answer';
    if (!refused && (await appears(page.locator('.ai-choice-ring'), 40_000))) {
      recorder.mark('aiRing');
    } else {
      // System one is the operator's own decision service, and a stand without it
      // answers 503 by design — the alert then stays exactly where it was. Rather than
      // film a press that led nowhere, the alert is closed the way a dispatcher would
      // close it by hand: the card still leaves the board with its own animation, and
      // the log says which of the two the reel is showing.
      console.log(`  no choice from System one (${verdict}) — resolving by hand instead`);
      const option = page
        .locator('[data-alert-id]')
        .first()
        .getByRole('button')
        .filter({ hasNotText: 'Решить с AI' })
        .first();
      if (await appears(option, 5000)) {
        await pointer.click(option, { travel: 700, settle: 320 });
        recorder.mark('resolvedByHand');
      }
    }
    if (targetId) {
      const card = page.locator(`[data-alert-id="${targetId}"]`);
      const until = Date.now() + 20_000;
      while (Date.now() < until) {
        if ((await card.count()) === 0) break;
        await page.waitForTimeout(300);
      }
    } else {
      await page.waitForTimeout(3000);
    }
    recorder.mark('alertGone');
    await page.waitForTimeout(1600);
  }
  await finish(recorder);
}

/**
 * Leaves the day in a state the quality model has something to say about.
 *
 * The icon that swaps a plan's grade for the assistant's reading of it is rendered for a
 * yellow or a red band and for nothing else, so a day that comes out perfect simply has
 * no such button to press. Rather than film a dialog with a hole in it, the scene asks
 * the header for a strategy that trades punctuality away, and checks.
 */
async function ensureGradedPlan(page: Page, pointer: Pointer): Promise<boolean> {
  for (const wanted of ['', ...RISKY_POLICIES]) {
    if (wanted) {
      const policy = page.getByRole('button', { name: /Политика:/ });
      if (!(await appears(policy, 5000))) break;
      await waitForRouterIdle();
      await dismissToasts(page);
      await policy.first().click();
      await settle(page, 1400);
      console.log(`  asking the day to run on "${wanted}"`);
      const took = await pickPolicy(page, pointer, null, wanted);
      console.log(took ? `  the day is on "${wanted}"` : `  "${wanted}" did not take`);
    }
    const metrics = page.getByRole('button', { name: /Метрики плана/ });
    if (!(await appears(metrics, 5000))) return false;
    await metrics.first().click();
    await appears(page.locator('#plan-metrics-title'), 8000);
    await settle(page, 7000);
    const explain = page.getByRole('button', { name: 'Объяснить с AI' });
    const graded = (await explain.count()) > 0;
    const close = page.getByRole('button', { name: 'Закрыть', exact: true });
    if (await close.count())
      await close
        .first()
        .click()
        .catch(() => {});
    await settle(page, 1200);
    if (graded) {
      console.log(
        `  the plan carries a grade the assistant can explain${wanted ? ` on "${wanted}"` : ''}`,
      );
      return true;
    }
  }
  console.log('  the plan stays green — the AI explanation has nothing to explain today');
  return false;
}

/**
 * The header's own controls, end to end, in one take.
 *
 * Policy panel, metrics dialog, the assistant on top of the plan's grade, and the door
 * through to the comparison. The reel plays this as one continuous move, so the cursor
 * walks between the controls rather than the edit cutting between them.
 */
async function scenePolicyMetrics(browser: Browser): Promise<void> {
  const page = await openDesk(browser);
  await resetBoard(page);
  // A cursor with nothing recording it: the grade has to be settled before the camera
  // rolls, and choosing a strategy is a press like any other.
  const graded = await ensureGradedPlan(page, new Pointer(page, null, at(DESK_VIEWPORT, 0.5, 0.5)));

  const { recorder, pointer } = await take(
    page,
    'policy-metrics',
    DESK_VIEWPORT,
    at(DESK_VIEWPORT, 0.49, 0.6),
  );
  recorder.mark('overview');
  await page.waitForTimeout(1200);

  const policy = page.getByRole('button', { name: /Политика:/ });
  if (await appears(policy, 5000)) {
    await pointer.click(policy.first(), { travel: 1100, settle: 300 });
    recorder.mark('policyOpen');
    await page.waitForTimeout(2000);
    const option = page.getByRole('button', { name: 'Бережнее к окнам' });
    if (await option.count()) {
      await pointer.moveOver(option.first(), 700);
      recorder.mark('policyHover');
      await page.waitForTimeout(1000);
    }
  }

  // Straight from the open panel to the metrics button: the press closes one and opens
  // the other, which is what the product does and what the storyboard asks to see.
  const metrics = page.getByRole('button', { name: /Метрики плана/ });
  if (await appears(metrics, 5000)) {
    await pointer.click(metrics.first(), { travel: 1200, settle: 320 });
    recorder.mark('metricsOpen');
    await appears(page.locator('#plan-metrics-title'), 8000);
    await page.waitForTimeout(4200);

    const optimise = page.getByRole('button', { name: /Оптимизировать/ });
    if (await appears(optimise, 5000)) {
      await pointer.click(optimise.first(), { travel: 760, settle: 320 });
      recorder.mark('optimisePressed');
      await page.waitForTimeout(1200);
    }

    if (graded) {
      const explain = page.getByRole('button', { name: 'Объяснить с AI' });
      if (await appears(explain, 6000)) {
        await pointer.click(explain.first(), { travel: 900, settle: 340 });
        recorder.mark('aiPressed');
        // The grade's own words dissolve into the assistant's; the reel gives that swap
        // only the moment it takes, then stays for what it turned into.
        await appears(page.getByText('Оценка AI'), 30_000);
        recorder.mark('aiAnswered');
        await page.waitForTimeout(3600);
      }
    }

    const compare = page.getByRole('button', { name: /Сравнить политики/ });
    if (await appears(compare, 5000)) {
      await pointer.click(compare.first(), { travel: 1000, settle: 340 });
      recorder.mark('comparePressed');
      await page.waitForTimeout(1600);
    }
  }

  recorder.mark('comparePage');
  await page.waitForTimeout(1200);
  await finish(recorder);
}

/**
 * The comparison, on a take of its own.
 *
 * It has to be a second take, and the reason is a fact about the product rather than a
 * preference: publishing a plan throws the comparison away, because a comparison is only
 * meaningful on the input it was run against. «Оптимизировать», one beat earlier, does
 * exactly that — so a comparison warmed before the dialog is stale by the time the page
 * opens, and the map answers «Карта не загрузилась» rather than drawing anything.
 *
 * So the recalculation happens between the takes, where a ninety-second wait costs the
 * reel nothing, and the filmed take opens on a page that already has an answer on it.
 */
async function scenePolicyCompare(browser: Browser): Promise<void> {
  const page = await openDesk(browser);
  if (!(await appears(page.getByText('Сравнение политик'), 6000))) {
    const nav = page.getByRole('button', { name: 'Политики', exact: true });
    if (!(await appears(nav, 5000))) {
      console.log('  no comparison page to film');
      return;
    }
    await nav.first().click();
    await settle(page, 2200);
  }
  await refreshComparison(page);

  const { recorder, pointer } = await take(
    page,
    'policy-compare',
    DESK_VIEWPORT,
    at(DESK_VIEWPORT, 0.5, 0.55),
  );
  recorder.mark('overview');
  await page.waitForTimeout(2400);

  const mapTab = page.getByRole('button', { name: 'Карта', exact: true });
  if (await appears(mapTab, 5000)) {
    await pointer.click(mapTab.first(), { travel: 1100, settle: 340 });
    recorder.mark('mapTab');
    // The map runs its own simulation of every strategy and swaps schematic lines for
    // real ones as they arrive; the take holds through that rather than cutting into it.
    await page.waitForTimeout(5000);
    recorder.mark('mapDrawing');
    await page.waitForTimeout(7000);
    recorder.mark('mapReady');
    await page.waitForTimeout(3000);
  }
  await finish(recorder);
}

/** Runs the comparison against the plan as it stands now, and waits for it to land. */
async function refreshComparison(page: Page): Promise<void> {
  const overview = page.getByRole('button', { name: 'Обзор', exact: true });
  if (await overview.count()) {
    await overview.first().click();
    await settle(page, 1200);
  }
  const refresh = page.getByRole('button', { name: /^(Сравнить|Пересчитать)$/ });
  if (!(await appears(refresh, 6000))) return;
  await refresh.first().click();
  console.log('  asking the stand for a policy comparison…');
  const empty = page.getByText(/Запустите сравнение|ещё не считал/i);
  const until = Date.now() + 150_000;
  while (Date.now() < until) {
    if ((await empty.count()) === 0) break;
    await page.waitForTimeout(3000);
  }
  await settle(page, 2000);
  console.log(
    (await empty.count()) === 0
      ? '  the comparison has an answer'
      : '  the comparison did not fill in time',
  );
}

/**
 * Closes a few alerts by hand, off camera.
 *
 * The dispatcher's result of the day scores how many blocking alerts were actually dealt
 * with, and a day where none were reads 0/100 no matter how well the plan went. The reel
 * films one of them being closed; the rest are closed here, the same way, so the closing
 * screen reports a day somebody worked rather than a day nobody touched.
 */
async function clearSomeAlerts(page: Page, count = 4): Promise<void> {
  await page.getByRole('button', { name: 'Алерты', exact: true }).click();
  await settle(page, 2500);
  for (let i = 0; i < count; i += 1) {
    const card = page.locator('[data-alert-id]').first();
    if ((await card.count()) === 0) break;
    const option = card.getByRole('button').filter({ hasNotText: 'Решить с AI' }).first();
    if (!(await pressable(page, option, 20_000))) break;
    await option.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(2600);
  }
  const left = await page.locator('[data-alert-id]').count();
  console.log(`  alerts left on the board: ${left}`);
}

/**
 * The day is closed and the dispatcher's own result comes up.
 *
 * Filmed on the plain board — no engineer chosen, no panel open — because the reel
 * closes the results again on this same take and ends on the map behind them, and then
 * pulls away from that map to find it sitting on a desk.
 */
async function sceneDayEnd(browser: Browser): Promise<void> {
  const page = await openDesk(browser);
  await resetBoard(page);
  const { recorder, pointer } = await take(
    page,
    'day-end',
    DESK_VIEWPORT,
    at(DESK_VIEWPORT, 0.62, 0.51),
  );
  recorder.mark('board');
  await page.waitForTimeout(900);

  await pointer.click(page.getByRole('button', { name: 'Меню пользователя' }), { travel: 1100 });
  recorder.mark('menu');
  await page.waitForTimeout(1200);

  const end = page.getByRole('button', { name: 'Завершить день' });
  if (!(await appears(end, 5000))) {
    console.log('  the day cannot be closed from this menu');
    await finish(recorder);
    return;
  }
  await pointer.click(end.first(), { travel: 620 });
  recorder.mark('confirm');
  await page.waitForTimeout(1400);

  // The confirmation is its own dialog: it focuses its field, takes the word one
  // keystroke at a time, and only then lets its own button through.
  const dialog = page
    .locator('[role="dialog"]')
    .filter({ hasText: /Завершить день/ })
    .first();
  if (await appears(dialog, 6000)) {
    await page.keyboard.type('ЗАВЕРШИТЬ', { delay: 85 });
    recorder.mark('typed');
    await page.waitForTimeout(700);
    const confirm = dialog.getByRole('button').last();
    if (await appears(confirm, 5000)) {
      await pointer.click(confirm, { travel: 600 });
      recorder.mark('closed');
    }
  } else {
    console.log('  no confirmation dialog opened');
  }

  await appears(page.getByText(/Результат рабочего дня|День под контролем/), 20_000);
  await page.waitForTimeout(1600);
  recorder.mark('results');
  await page.waitForTimeout(5200);

  // The results are closed again on the same take: the reel ends the day on the board,
  // not on a panel, and then pulls back from it.
  const close = page.getByRole('button', { name: 'Закрыть итоги' });
  if (await appears(close, 6000)) {
    await pointer.click(close.first(), { travel: 900, settle: 320 });
    recorder.mark('resultsClosed');
    await page.waitForTimeout(1400);
    // Park the pointer off the board, so the last frames are the product alone.
    await pointer.moveTo(DESK_VIEWPORT.width * 0.93, DESK_VIEWPORT.height * 0.93, 700);
    recorder.mark('boardAlone');
    await page.waitForTimeout(6000);
  }
  await finish(recorder);
}

/**
 * Quiet loops of both phones, for the corners of the closing shot.
 *
 * A settled list repaints nothing, and a take of a still page is a single frame, so each
 * phone is given something to do: the engineer's day is scrolled from the top, the
 * customer's history is opened.
 */
async function sceneOutroPhones(engineer: Page, client: Page): Promise<void> {
  const engTake = await take(
    engineer,
    'outro-engineer',
    PHONE_VIEWPORT,
    at(PHONE_VIEWPORT, 0.5, 0.55),
  );
  engTake.recorder.mark('idle');
  await scrollSmooth(engineer, -3000, 1400, at(PHONE_VIEWPORT, 0.5, 0.55));
  await engineer.waitForTimeout(700);
  await scrollSmooth(engineer, 760, 2200, at(PHONE_VIEWPORT, 0.5, 0.55));
  await engineer.waitForTimeout(1600);
  await finish(engTake.recorder);

  const clientTake = await take(
    client,
    'outro-client',
    PHONE_VIEWPORT,
    at(PHONE_VIEWPORT, 0.5, 0.55),
  );
  clientTake.recorder.mark('idle');
  // «Заявка отправлена» offers the history directly; the drawer is the fallback.
  const list = client.getByRole('button', { name: 'Мои заявки' });
  if (!(await list.count())) {
    const menu = client.getByRole('button', { name: 'Меню' });
    if (await appears(menu, 4000)) {
      await clientTake.pointer.click(menu.first(), { travel: 700 });
      await client.waitForTimeout(1200);
    }
  }
  if (await appears(list, 5000)) {
    await clientTake.pointer.click(list.first(), { travel: 800 });
    await client.waitForTimeout(3400);
  }
  await scrollSmooth(client, 620, 1800, at(PHONE_VIEWPORT, 0.5, 0.55));
  await client.waitForTimeout(1600);
  await finish(clientTake.recorder);
}

// ---------------------------------------------------------------------------

async function main() {
  await mkdir(RAW, { recursive: true });
  await writeFile(LOCK, `${new Date().toISOString()}\n`, 'utf8');
  const browser = await chromium.launch({ args: launchArgs() });

  type Surface = { context: BrowserContext; page: Page };
  let engineer: Surface | null = null;
  let client: Surface | null = null;

  try {
    if (wanted('open')) {
      console.log('scene: open');
      await sceneOpen(browser);
    }
    if (wanted('engineers')) {
      console.log('scene: engineers');
      await sceneEngineers(browser);
    }
    if (wanted('engineer')) {
      console.log('scene: engineer');
      if (!wanted('open')) await startDay(browser);
      engineer = await sceneEngineerLogin(browser);
      await sceneEngineerDay(engineer.page);
    } else if (wanted('engineer-day')) {
      console.log('scene: engineer-day');
      engineer = await openEngineerPhone(browser);
      await sceneEngineerDay(engineer.page);
    }
    if (engineer) {
      console.log('working the rest of the day off camera');
      await workTheDay(engineer.page);
    }
    if (wanted('client') || wanted('replan')) {
      console.log('scene: client + replan, filmed together');
      await bringCrewOnLine();
      const desktop = wanted('replan') ? openDesk(browser) : null;
      if (desktop) await desktop;
      const clientRun: Promise<Surface> = sceneClient(browser);
      if (wanted('replan')) {
        await sceneReplan(browser, clientRun);
      }
      client = await clientRun;
    }
    if (wanted('ai-chat')) {
      console.log('scene: ai-chat');
      await bringCrewOnLine();
      await sceneAiChat(browser);
    }
    if (wanted('alert-solve')) {
      console.log('scene: alert-solve');
      await sceneAlertSolve(browser);
    }
    if (wanted('policy-metrics')) {
      console.log('scene: policy-metrics');
      await bringCrewOnLine();
      await scenePolicyMetrics(browser);
    }
    if (wanted('policy-metrics') || wanted('policy-compare')) {
      console.log('scene: policy-compare');
      await scenePolicyCompare(browser);
    }
    if (wanted('outro') && engineer && client) {
      console.log('scene: outro phones');
      await sceneOutroPhones(engineer.page, client.page);
    }
    if (wanted('day-end')) {
      // One more pass over the day before it is closed. By now a good deal more logical
      // time has passed than when the engineer was filmed, so visits that were not yet
      // startable then can be taken and closed now — and the result of the day is built
      // out of exactly that. Worth a phone of its own when this scene is re-shot alone,
      // because a day nobody worked closes on a screen full of zeroes.
      engineer ??= await openEngineerPhone(browser);
      console.log('working the last of the day off camera');
      await workTheDay(engineer.page, 3);
      const board = await openDesk(browser);
      await clearSomeAlerts(board);
      await resetBoard(board);
      console.log('scene: day-end');
      await sceneDayEnd(browser);
    }
  } finally {
    await writeFile(
      `${RAW}/index.json`,
      `${JSON.stringify(
        captured.map(({ scene, width, height, duration, marks, frames }) => ({
          scene,
          width,
          height,
          duration,
          frames: frames.length,
          marks,
        })),
        null,
        2,
      )}\n`,
      'utf8',
    );
    await engineer?.context.close().catch(() => {});
    await client?.context.close().catch(() => {});
    await deskCtx?.close().catch(() => {});
    await browser.close();
    await rm(LOCK, { force: true });
  }
  console.log('capture done ->', RAW);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
