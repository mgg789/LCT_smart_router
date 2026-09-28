/**
 * Small acting helpers shared by the scene scripts: typing with a human cadence,
 * scrolling that eases instead of jumping, and waiting on a locator without letting
 * one missing element end a take.
 */
import type { Locator, Page } from 'playwright';

/** Types into whatever holds focus, with the uneven rhythm of a person at a keyboard. */
export async function typeHuman(page: Page, text: string, base = 52): Promise<void> {
  for (const char of text) {
    const jitter = base * (0.55 + Math.random() * 0.95);
    await page.keyboard.type(char, { delay: 0 });
    // A space after a word is where a typist actually pauses.
    await page.waitForTimeout(char === ' ' ? jitter * 1.6 : jitter);
  }
}

/** Wheel-scrolls a page in eased steps, so the footage reads as one continuous glide. */
export async function scrollSmooth(
  page: Page,
  distance: number,
  ms = 1400,
  at?: { x: number; y: number },
): Promise<void> {
  const steps = Math.max(10, Math.round(ms / 16));
  let done = 0;
  if (at) await page.mouse.move(at.x, at.y);
  for (let i = 1; i <= steps; i += 1) {
    const p = i / steps;
    const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    const target = distance * eased;
    await page.mouse.wheel(0, target - done);
    done = target;
    await page.waitForTimeout(ms / steps);
  }
}

/** True when the locator turned up within the budget; never throws. */
export async function appears(locator: Locator, timeout = 8000): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** Reads the one-time code out of the app's own login request. */
export function watchLoginCode(page: Page, timeout = 25_000): Promise<string | null> {
  return page
    .waitForResponse(
      (r) => r.url().includes('/auth/login-code') && r.request().method() === 'POST',
      { timeout },
    )
    .then(async (r) => {
      const body = (await r.json()) as { devCode?: string };
      return body.devCode ?? null;
    })
    .catch(() => null);
}
