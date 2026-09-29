/**
 * A cursor that really moves.
 *
 * Playwright drives the mouse for the hover states the app actually shows, and every
 * move is written into the scene meta so the reel can draw the pointer back over the
 * footage at the exact moment and place it happened — headless Chrome paints no cursor
 * of its own.
 *
 * The path is eased rather than linear: a straight jump reads as a teleport on screen.
 */
import type { Locator, Page } from 'playwright';
import type { Recorder } from './recorder.ts';

/** Slow start, fast middle, soft landing — the shape a hand actually draws. */
function easeInOutCubic(p: number): number {
  return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
}

export class Pointer {
  private readonly page: Page;
  /** Absent when the cursor is being driven off camera, between takes. */
  private readonly recorder: Recorder | null;
  private x: number;
  private y: number;

  constructor(page: Page, recorder: Recorder | null, start: { x: number; y: number }) {
    this.page = page;
    this.recorder = recorder;
    this.x = start.x;
    this.y = start.y;
  }

  get position(): { x: number; y: number } {
    return { x: this.x, y: this.y };
  }

  /** Glides to a point over `ms`, sampling often enough to read as one movement. */
  async moveTo(x: number, y: number, ms = 700): Promise<void> {
    const fromX = this.x;
    const fromY = this.y;
    const steps = Math.max(8, Math.round(ms / 16));
    for (let i = 1; i <= steps; i += 1) {
      const p = easeInOutCubic(i / steps);
      const nextX = fromX + (x - fromX) * p;
      const nextY = fromY + (y - fromY) * p;
      await this.page.mouse.move(nextX, nextY);
      this.recorder?.notePointer('move', nextX, nextY);
      await this.page.waitForTimeout(ms / steps);
    }
    this.x = x;
    this.y = y;
  }

  /** Centre of a live element, in CSS pixels. */
  async centreOf(locator: Locator): Promise<{ x: number; y: number }> {
    const box = await locator.boundingBox();
    if (!box) throw new Error('the element the cursor was sent to has no box on screen');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  async moveOver(locator: Locator, ms = 700): Promise<void> {
    await this.reveal(locator);
    const { x, y } = await this.centreOf(locator);
    await this.moveTo(x, y, ms);
  }

  /**
   * Scrolls an element that sits past the bottom of the viewport into view with the
   * wheel, the way a person would, so the take shows the scroll instead of a jump.
   */
  async reveal(locator: Locator): Promise<void> {
    const box = await locator.boundingBox();
    const viewport = this.page.viewportSize();
    if (!box || !viewport || box.y + box.height <= viewport.height) return;
    const overshoot = box.y + box.height - (viewport.height - 72);
    const steps = 8;
    for (let index = 0; index < steps; index += 1) {
      await this.page.mouse.wheel(0, overshoot / steps);
      await this.page.waitForTimeout(28);
    }
    await this.page.waitForTimeout(220);
    const after = await locator.boundingBox();
    if (after && after.y + after.height > viewport.height) {
      await locator.scrollIntoViewIfNeeded();
      await this.page.waitForTimeout(200);
    }
  }

  /** Presses where the cursor already is, with the small pause a real press has. */
  async press(): Promise<void> {
    this.recorder?.notePointer('down', this.x, this.y);
    await this.page.mouse.down();
    await this.page.waitForTimeout(90);
    await this.page.mouse.up();
    this.recorder?.notePointer('up', this.x, this.y);
  }

  /** Travels to the element, lets the hover state settle, then presses it. */
  async click(locator: Locator, { travel = 700, settle = 260 } = {}): Promise<void> {
    await this.moveOver(locator, travel);
    await this.page.waitForTimeout(settle);
    await this.press();
  }
}
