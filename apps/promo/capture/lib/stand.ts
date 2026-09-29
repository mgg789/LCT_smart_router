/**
 * Talking to the running stand: browser contexts sized for each surface, and the
 * real login codes the stand exposes on a development contour.
 *
 * Nothing here fakes a screen. A seeded session only skips a login the reel does not
 * film; every login the reel does film is typed into the real form.
 */
import type { Browser, BrowserContext, Page } from 'playwright';

export const WEB = process.env.PROMO_WEB ?? 'http://127.0.0.1:5173';
export const API = process.env.PROMO_API ?? 'http://127.0.0.1:8000/api/v1';

export const DISPATCHER_EMAIL = process.env.PROMO_DISPATCHER_EMAIL ?? 'dispatcher@example.test';
export const ENGINEER_EMAIL = process.env.PROMO_ENGINEER_EMAIL ?? 'test@mail.ru';
export const CLIENT_EMAIL = process.env.PROMO_CLIENT_EMAIL ?? 'example@gmail.com';

/**
 * The dispatcher artboard is 1920x1080, so this viewport renders it at 1.5x.
 *
 * The size is set by what the screencast can carry: it delivers about 21 frames a second
 * at 3840x2160, 37 at 2880x1620 and 60 at 1920x1080. 1.5x keeps the reel's push-ins
 * pixel-true while leaving the capture fast enough for the app's own transitions.
 */
export const DESK_VIEWPORT = { width: 2880, height: 1620 } as const;

/**
 * The phone surfaces are filmed at the size they are actually built for.
 *
 * Lifting the 430px column cap would draw more pixels, and almost everything on these
 * screens does scale with `--eu`. Almost: the shift overlay sets a few sizes in plain
 * pixels, and at a wider column those stop matching the rest — the reel would be showing
 * a layout the app never renders. Native width keeps the screens honest, and a screencast
 * of this size runs at about 60 frames a second, which the typing and scrolling need more
 * than the extra pixels. The reel shows a phone around 870px tall, so this is very nearly
 * one to one.
 */
export const PHONE_VIEWPORT = { width: 430, height: 932 } as const;

export type Role = 'dispatcher' | 'engineer' | 'client';

export interface Session {
  readonly token: string;
  readonly email: string;
  readonly expiresAt: number;
}

/**
 * Asks the stand for a code and reads it back from the same answer.
 *
 * Issuing retires whatever code was outstanding for the address, so a caller that
 * wants the app itself to ask must watch the app's own response instead of calling this.
 */
export async function issueCode(email: string): Promise<string> {
  const res = await fetch(`${API}/auth/login-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const body = (await res.json()) as { devCode?: string };
  if (!body.devCode) {
    throw new Error(`the stand did not expose a login code for ${email}`);
  }
  return body.devCode;
}

export async function signIn(email: string, role: Role): Promise<Session> {
  const code = await issueCode(email);
  const res = await fetch(`${API}/auth/login-code/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code, role }),
  });
  const body = (await res.json()) as { token?: string; expiresAt?: number; error?: unknown };
  if (!body.token || !body.expiresAt) {
    throw new Error(`${role} sign-in failed: ${JSON.stringify(body)}`);
  }
  return { token: body.token, email, expiresAt: body.expiresAt };
}

const CHROME_ARGS = [
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--hide-scrollbars',
  '--disable-features=CalculateNativeWinOcclusion',
  '--enable-gpu-rasterization',
];

export function launchArgs(): string[] {
  return [...CHROME_ARGS];
}

export async function deskContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { ...DESK_VIEWPORT },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    reducedMotion: 'no-preference',
    colorScheme: 'light',
  });
}

/** A phone context at the app's own column width — nothing rescaled, nothing injected. */
export async function phoneContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { ...PHONE_VIEWPORT },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    reducedMotion: 'no-preference',
    colorScheme: 'light',
  });
}

/** Seeds a session for a surface whose login this scene does not film. */
export async function seedSession(
  context: BrowserContext,
  role: Role,
  session: Session,
): Promise<void> {
  const payload = JSON.stringify({
    token: session.token,
    email: session.email,
    expiresAt: session.expiresAt,
  });
  await context.addInitScript(
    ({ role: seededRole, token, payload: stored }) => {
      try {
        if (seededRole === 'dispatcher') {
          sessionStorage.setItem('lct.dispatcher.session', token);
        } else if (seededRole === 'engineer') {
          localStorage.setItem('lct.engineer.session', stored);
        } else {
          localStorage.setItem('lct.client.session', stored);
        }
      } catch {
        /* A blocked store just means the scene logs in through the form instead. */
      }
    },
    { role, token: session.token, payload },
  );
}

/**
 * Takes the focus ring off the six code cells.
 *
 * The cells themselves carry no border — what the camera sees is Chrome's own focus
 * outline on the cell being typed into, drawn in the platform's colour and owing nothing
 * to the app's design. On a phone the product is never used with a keyboard, so the ring
 * is furniture the shoot introduced; this removes it and changes nothing else.
 */
export async function hideCodeCellFocus(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const css =
      'input[aria-label^="Цифра "]{outline:none!important;box-shadow:none!important;' +
      'border-color:transparent!important;-webkit-appearance:none!important;appearance:none!important}';
    const apply = () => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    };
    if (document.head) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  });
}

/**
 * Takes the browser's own focus ring off fields the reel types into.
 *
 * The assistant's composer already sets `outline-none`. Headless Chrome still draws
 * the platform focus ring the moment the caret lands, and that ring is not part of
 * the product. Code cells are covered separately by {@link hideCodeCellFocus}.
 */
export async function hideCaptureFocus(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const css =
      'textarea, input, button, [contenteditable="true"]{outline:none!important}' +
      'textarea:focus, textarea:focus-visible, input:focus, input:focus-visible,' +
      'button:focus, button:focus-visible{outline:none!important;box-shadow:none!important}';
    const apply = () => {
      const style = document.createElement('style');
      style.dataset.promoFocus = 'off';
      style.textContent = css;
      document.head.appendChild(style);
    };
    if (document.head) apply();
    else document.addEventListener('DOMContentLoaded', apply, { once: true });
  });
}

/** Clears the "the dispatcher already pressed start today" flag so the reel can film it. */
export async function forgetWorkdayStart(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      localStorage.removeItem('lct.dispatcher.workday.started');
    } catch {
      /* Nothing to forget. */
    }
  });
}

/** Settles a page: fonts loaded, first paint done, animations past their entrance. */
export async function settle(page: Page, ms = 900): Promise<void> {
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(ms);
}
