/**
 * Turns each take into constant-rate footage the reel can scrub frame by frame.
 *
 * A screencast delivers frames only when the page paints, so a take is a list of images
 * with the moment each was composited. Re-timing them through ffmpeg's concat demuxer
 * keeps every frame at exactly the instant it happened: a still stretch costs one held
 * frame, a burst of animation keeps all of its frames, and the result is a 60 fps file
 * whose timeline matches the wall clock of the capture.
 *
 * Run: node capture/encode.ts
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import type { SceneMeta } from './lib/recorder.ts';

const run = promisify(execFile);

const RAW = 'out/raw';
const PUBLIC = 'public/footage';
const MANIFEST = 'src/footage.json';
const FPS = 60;
/** How long the final frame of a take stays on screen. */
const TAIL = 0.4;

export interface FootageEntry {
  readonly scene: string;
  readonly file: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly marks: Readonly<Record<string, number>>;
  readonly pointer: SceneMeta['pointer'];
}

async function encodeScene(scene: string): Promise<FootageEntry | null> {
  const dir = join(RAW, scene);
  let meta: SceneMeta;
  try {
    meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as SceneMeta;
  } catch {
    console.log(`  ${scene}: no meta.json, skipped`);
    return null;
  }
  if (meta.frames.length === 0) {
    console.log(`  ${scene}: no frames, skipped`);
    return null;
  }

  const lines: string[] = ['ffconcat version 1.0'];
  // A take that started before its first paint holds that paint back to zero, so the
  // scene's own marks stay on the same timeline as the footage.
  const offset = meta.frames[0]?.t ?? 0;
  meta.frames.forEach((frame, index) => {
    const next = meta.frames[index + 1];
    const start = index === 0 ? 0 : frame.t - offset;
    const end = next ? next.t - offset : meta.duration - offset + TAIL;
    lines.push(`file '${frame.file}'`);
    lines.push(`duration ${Math.max(1 / 240, end - start).toFixed(4)}`);
  });
  // The concat demuxer drops the last entry's duration unless the file is repeated.
  const last = meta.frames[meta.frames.length - 1];
  if (last) lines.push(`file '${last.file}'`);

  const listPath = join(dir, 'concat.txt');
  await writeFile(listPath, `${lines.join('\n')}\n`, 'utf8');

  const out = join(PUBLIC, `${scene}.mp4`);
  await rm(out, { force: true });
  await run(
    ffmpegPath as string,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'concat.txt',
      // h.264 needs even dimensions; a phone take is an odd number of pixels tall.
      '-vf',
      `crop=trunc(iw/2)*2:trunc(ih/2)*2,fps=${FPS}`,
      '-fps_mode',
      'cfr',
      '-r',
      String(FPS),
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '15',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      join('..', '..', '..', PUBLIC, `${scene}.mp4`),
    ],
    { cwd: dir, maxBuffer: 1 << 26 },
  );

  const duration = meta.duration - offset + TAIL;
  const shift = (t: number) => Math.max(0, t - offset);
  console.log(`  ${scene}: ${meta.frames.length} frames -> ${duration.toFixed(2)}s at ${FPS} fps`);
  return {
    scene,
    file: `footage/${scene}.mp4`,
    width: meta.width - (meta.width % 2),
    height: meta.height - (meta.height % 2),
    duration,
    marks: Object.fromEntries(Object.entries(meta.marks).map(([k, v]) => [k, shift(v)])),
    pointer: meta.pointer.map((event) => ({ ...event, t: shift(event.t) })),
  };
}

async function main() {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary');
  // Encoding a take while the capture is rewriting it produces a file made of two
  // different takes, and nothing about it looks wrong until the reel is watched.
  if (existsSync(join(RAW, '.capturing'))) {
    throw new Error('a capture is running — wait for it to finish, then encode');
  }
  await mkdir(PUBLIC, { recursive: true });
  const scenes = (await readdir(RAW, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const entries: FootageEntry[] = [];
  for (const scene of scenes) {
    const entry = await encodeScene(scene);
    if (entry) entries.push(entry);
  }
  // A reshoot of one scene must not drop the takes that were not filmed this pass.
  // Raw frames are deleted after a successful encode, so the previous manifest is the
  // only copy of every scene that is not in `out/raw` right now.
  let previous: FootageEntry[] = [];
  try {
    previous = JSON.parse(await readFile(MANIFEST, 'utf8')) as FootageEntry[];
  } catch {
    previous = [];
  }
  const fresh = new Set(entries.map((entry) => entry.scene));
  const kept = previous.filter((entry) => !fresh.has(entry.scene));
  const merged = [...kept, ...entries].sort((a, b) => a.scene.localeCompare(b.scene));
  await writeFile(MANIFEST, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  console.log(
    `encoded ${entries.length} scenes, kept ${kept.length} -> ${PUBLIC}, manifest -> ${MANIFEST}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
