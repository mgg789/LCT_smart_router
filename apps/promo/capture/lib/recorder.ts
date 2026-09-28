/**
 * Frame recorder built on the CDP screencast.
 *
 * A screencast frame arrives whenever the page paints, carrying the wall-clock moment
 * it was composited. We keep those moments and resample to a constant frame rate at
 * encode time, so a stretch where nothing moved costs nothing and a burst of animation
 * keeps every frame the browser actually drew.
 *
 * Screencast frames carry CSS pixels and ignore the device scale factor, so resolution
 * comes from the viewport: the dispatcher is filmed on a 3840x2160 viewport, which its
 * own artboard scaling turns into a 2x render of the 1920x1080 design.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright';

export interface FrameRecord {
  /** Seconds since the recording started. */
  readonly t: number;
  readonly file: string;
}

export interface PointerEventRecord {
  readonly t: number;
  readonly kind: 'move' | 'down' | 'up';
  /** Fraction of the frame width / height, so the reel can place the cursor at any size. */
  readonly x: number;
  readonly y: number;
}

export interface SceneMeta {
  readonly scene: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly frames: readonly FrameRecord[];
  readonly pointer: readonly PointerEventRecord[];
  /** Named instants the reel cuts on, in seconds from the scene start. */
  readonly marks: Readonly<Record<string, number>>;
}

export class Recorder {
  private cdp: CDPSession | null = null;
  private readonly frames: FrameRecord[] = [];
  private readonly pointer: PointerEventRecord[] = [];
  private readonly marks: Record<string, number> = {};
  private readonly writes: Promise<unknown>[] = [];
  private index = 0;
  private startedAt = 0;
  private stopped = false;

  private readonly page: Page;
  private readonly scene: string;
  private readonly dir: string;
  private readonly viewport: { width: number; height: number };

  constructor(page: Page, scene: string, dir: string, viewport: { width: number; height: number }) {
    this.page = page;
    this.scene = scene;
    this.dir = dir;
    this.viewport = viewport;
  }

  get elapsed(): number {
    return this.startedAt === 0 ? 0 : (Date.now() - this.startedAt) / 1000;
  }

  async start(): Promise<void> {
    const sceneDir = join(this.dir, this.scene);
    // Windows refuses to remove a directory another process is reading, which is what a
    // concurrent encode looks like. Retrying a few times turns a lost take into a pause.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(sceneDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt >= 5) throw error;
        console.log(`  ${this.scene}: the previous take is still in use, retrying`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    await mkdir(sceneDir, { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.startedAt = Date.now();
    this.cdp.on('Page.screencastFrame', (frame) => {
      const ack = this.cdp
        ?.send('Page.screencastFrameAck', { sessionId: frame.sessionId })
        .catch(() => {});
      if (this.stopped) return;
      const name = `${String(this.index++).padStart(6, '0')}.jpg`;
      this.frames.push({ t: (Date.now() - this.startedAt) / 1000, file: name });
      this.writes.push(
        Promise.resolve(ack).then(() =>
          writeFile(join(sceneDir, name), Buffer.from(frame.data, 'base64')),
        ),
      );
    });
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 76,
      everyNthFrame: 1,
    });
  }

  /** Names the current instant so the reel can cut, zoom or overlay exactly here. */
  mark(name: string): void {
    this.marks[name] = this.elapsed;
  }

  notePointer(kind: PointerEventRecord['kind'], cssX: number, cssY: number): void {
    this.pointer.push({
      t: this.elapsed,
      kind,
      x: cssX / this.viewport.width,
      y: cssY / this.viewport.height,
    });
  }

  async stop(): Promise<SceneMeta> {
    this.stopped = true;
    const duration = this.elapsed;
    await this.cdp?.send('Page.stopScreencast').catch(() => {});
    await Promise.all(this.writes);
    this.cdp = null;
    const meta: SceneMeta = {
      scene: this.scene,
      width: this.viewport.width,
      height: this.viewport.height,
      duration,
      frames: this.frames,
      pointer: this.pointer,
      marks: this.marks,
    };
    await writeFile(
      join(this.dir, this.scene, 'meta.json'),
      `${JSON.stringify(meta, null, 2)}\n`,
      'utf8',
    );
    return meta;
  }
}
