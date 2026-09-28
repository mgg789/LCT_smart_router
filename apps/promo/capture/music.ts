/**
 * The reel's own soundtrack, synthesised rather than licensed.
 *
 * A promo cut to someone else's track is a promo that cannot be published, so the music
 * is written here: a driving four-to-the-floor at 124 beats a minute in A minor, built
 * out of oscillators and envelopes and nothing else. Everything is deterministic, so the
 * same file comes out of every machine that runs it, and the arrangement is laid out
 * against the reel's own sections — the beat lands where the sections change.
 *
 * Run: node capture/music.ts            -> public/audio/reel.m4a
 *      node capture/music.ts --wav      keep the intermediate wav for listening
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const run = promisify(execFile);

const RATE = 44_100;
const BPM = 124;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
/** Long enough to cover the reel with a tail to fade under the last card. */
const BARS = 62;
const LENGTH = BARS * BAR;

const TAU = Math.PI * 2;

/** Semitones above A1 (55 Hz) for the note names the arrangement uses. */
const NOTE: Record<string, number> = {
  A: 0,
  B: 2,
  C: 3,
  D: 5,
  E: 7,
  F: 8,
  G: 10,
};

const hz = (name: string, octave: number) => 55 * 2 ** ((NOTE[name] ?? 0) / 12 + octave);

/**
 * The harmony: eight bars of A minor that say "this is going somewhere".
 *
 * i – VI – III – VII is the progression every piece of software marketing is cut to,
 * and for once that is the right reason to use it: it needs no resolution, so it can be
 * cut into and out of at any bar without sounding like an edit.
 */
const PROGRESSION = [
  { root: 'A', third: 'C', fifth: 'E' },
  { root: 'F', third: 'A', fifth: 'C' },
  { root: 'C', third: 'E', fifth: 'G' },
  { root: 'G', third: 'B', fifth: 'D' },
] as const;

/**
 * The arrangement, bar by bar.
 *
 * Each section names what plays, so the track opens sparse under the logo, fills out
 * when the product appears, drops back for the quiet stretch in the middle of the story
 * and comes back up for the close.
 */
interface Section {
  readonly from: number;
  readonly kick: boolean;
  readonly bass: boolean;
  readonly arp: number;
  readonly hats: number;
  readonly clap: boolean;
  readonly pad: number;
  readonly lead: number;
}

const SECTIONS: readonly Section[] = [
  // the logo and the first screen
  { from: 0, kick: false, bass: false, arp: 0.35, hats: 0, clap: false, pad: 0.5, lead: 0 },
  { from: 2, kick: true, bass: true, arp: 0.5, hats: 0.3, clap: false, pad: 0.55, lead: 0 },
  // the board, the map, the crew
  { from: 6, kick: true, bass: true, arp: 0.75, hats: 0.55, clap: true, pad: 0.5, lead: 0.4 },
  // the engineer
  { from: 14, kick: true, bass: true, arp: 0.6, hats: 0.5, clap: true, pad: 0.6, lead: 0.25 },
  // the customer
  { from: 22, kick: true, bass: true, arp: 0.5, hats: 0.4, clap: true, pad: 0.7, lead: 0.15 },
  // the rebuild
  { from: 28, kick: true, bass: true, arp: 0.8, hats: 0.6, clap: true, pad: 0.5, lead: 0.5 },
  // the assistant
  { from: 34, kick: true, bass: true, arp: 0.7, hats: 0.55, clap: true, pad: 0.75, lead: 0.45 },
  // control
  { from: 42, kick: true, bass: true, arp: 0.85, hats: 0.65, clap: true, pad: 0.55, lead: 0.55 },
  // the close of the day and the desk
  { from: 52, kick: true, bass: true, arp: 0.6, hats: 0.45, clap: true, pad: 0.9, lead: 0.6 },
  { from: 59, kick: false, bass: false, arp: 0.2, hats: 0, clap: false, pad: 1, lead: 0.3 },
];

function sectionAt(bar: number): Section {
  let found = SECTIONS[0] as Section;
  for (const section of SECTIONS) if (bar >= section.from) found = section;
  return found;
}

// --- voices -----------------------------------------------------------------

const decay = (t: number, tau: number) => Math.exp(-t / tau);

/**
 * Band-limited oscillators.
 *
 * A naive sawtooth is a straight line reset to the bottom once a cycle, and that reset
 * is a step with energy all the way up past half the sample rate, which folds back down
 * as a hiss that sits over everything. PolyBLEP rounds the corner over one sample: the
 * wave keeps its shape and its brightness, and the fold-back goes away.
 */
function polyBlep(phase: number, dt: number): number {
  if (phase < dt) {
    const t = phase / dt;
    return t + t - t * t - 1;
  }
  if (phase > 1 - dt) {
    const t = (phase - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function saw(freq: number, t: number): number {
  const dt = freq / RATE;
  const phase = (freq * t) % 1;
  return 2 * phase - 1 - polyBlep(phase < 0 ? phase + 1 : phase, dt);
}

function square(freq: number, t: number): number {
  const dt = freq / RATE;
  const phase = (freq * t) % 1;
  const p = phase < 0 ? phase + 1 : phase;
  const raw = p < 0.5 ? 1 : -1;
  return raw - polyBlep(p, dt) + polyBlep((p + 0.5) % 1, dt);
}

/** Deterministic noise: the same "random" hiss on every machine. */
const noise = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43_758.5453;
  return (x - Math.floor(x)) * 2 - 1;
};

/** A kick with its pitch falling out from under it, which is what gives it the punch. */
function kick(t: number): number {
  if (t < 0 || t > 0.42) return 0;
  const pitch = 48 + 96 * decay(t, 0.024);
  const body = Math.sin(TAU * pitch * t) * decay(t, 0.13);
  const click = noise(t * RATE) * decay(t, 0.004) * 0.35;
  return body * 1.0 + click;
}

function clap(t: number): number {
  if (t < 0 || t > 0.3) return 0;
  // Three short bursts and a tail: a clap is a room full of hands, not one pair.
  const bursts = [0, 0.011, 0.023].reduce(
    (sum, offset) => sum + (t > offset ? noise((t - offset) * RATE) * decay(t - offset, 0.009) : 0),
    0,
  );
  return (bursts * 0.5 + noise(t * RATE) * decay(t, 0.09) * 0.42) * 0.55;
}

function hat(t: number, open: boolean): number {
  const tau = open ? 0.12 : 0.028;
  if (t < 0 || t > tau * 6) return 0;
  return noise(t * RATE * 1.7) * decay(t, tau) * 0.22;
}

/** A plucked saw through a falling filter — the one-pole is enough at this size. */
function pluck(t: number, freq: number, tau: number): number {
  if (t < 0 || t > tau * 5) return 0;
  const env = decay(t, tau);
  const raw = saw(freq, t) * 0.6 + saw(freq * 1.005, t) * 0.4;
  // A cheap low-pass that opens with the attack and closes with the tail.
  const cut = 0.25 + 0.6 * env;
  return raw * env * cut;
}

function subBass(t: number, freq: number): number {
  return (Math.sin(TAU * freq * t) * 0.86 + square(freq, t) * 0.1) * 0.9;
}

/** Three detuned saws, slow in and slow out: the bed everything else sits on. */
function padVoice(t: number, freq: number, length: number): number {
  const attack = Math.min(1, t / 0.5);
  const release = Math.min(1, Math.max(0, (length - t) / 0.7));
  const wobble = 1 + 0.0016 * Math.sin(TAU * 0.23 * t);
  return (
    (saw(freq * wobble, t) + saw(freq * 1.006, t) + saw(freq * 0.994, t)) * 0.15 * attack * release
  );
}

/** The riser that says a section is about to change. */
function riser(t: number, length: number): number {
  if (t < 0 || t > length) return 0;
  const p = t / length;
  return noise(t * RATE) * (0.05 + 0.5 * p ** 3) * (0.3 + 0.7 * Math.sin((p * Math.PI) / 2));
}

// --- the arrangement --------------------------------------------------------

function render(): Float32Array[] {
  const frames = Math.ceil(LENGTH * RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  const add = (start: number, length: number, voice: (t: number) => number, pan = 0) => {
    const from = Math.max(0, Math.floor(start * RATE));
    const to = Math.min(frames, Math.ceil((start + length) * RATE));
    const l = Math.sqrt((1 - pan) / 2);
    const r = Math.sqrt((1 + pan) / 2);
    for (let i = from; i < to; i += 1) {
      const value = voice(i / RATE - start);
      left[i] += value * l;
      right[i] += value * r;
    }
  };

  /** Where the kick lands, so the bass can be ducked out from under it. */
  const kicks: number[] = [];

  for (let bar = 0; bar < BARS; bar += 1) {
    const at = bar * BAR;
    const section = sectionAt(bar);
    const chord = PROGRESSION[bar % PROGRESSION.length] as (typeof PROGRESSION)[number];
    const root = hz(chord.root, 1);

    if (section.pad > 0) {
      for (const [index, name] of [chord.root, chord.third, chord.fifth].entries()) {
        const freq = hz(name, index === 0 ? 2 : 3);
        add(at, BAR, (t) => padVoice(t, freq, BAR) * section.pad, (index - 1) * 0.5);
      }
    }

    for (let beat = 0; beat < 4; beat += 1) {
      const beatAt = at + beat * BEAT;
      if (section.kick) {
        kicks.push(beatAt);
        add(beatAt, 0.45, kick);
        // The extra push before the bar turns over.
        if (beat === 3 && bar % 4 === 3) {
          kicks.push(beatAt + BEAT * 0.5);
          add(beatAt + BEAT * 0.5, 0.45, (t) => kick(t) * 0.8);
        }
      }
      if (section.clap && beat % 2 === 1) add(beatAt, 0.32, clap);
      if (section.hats > 0) {
        for (const eighth of [0, 0.5]) {
          const open = eighth === 0.5 && beat === 3;
          add(
            beatAt + eighth * BEAT,
            0.4,
            (t) => hat(t, open) * section.hats * (eighth === 0 ? 0.7 : 1),
            eighth === 0 ? -0.25 : 0.25,
          );
        }
      }
    }

    if (section.bass) {
      // Sixteenth-note root movement with an octave lift on the back half of the bar.
      for (let step = 0; step < 8; step += 1) {
        const stepAt = at + step * (BEAT / 2);
        const freq = step % 4 === 3 ? root * 2 : root;
        add(stepAt, BEAT / 2, (t) => subBass(t, freq) * decay(t, 0.16) * 0.85);
      }
    }

    if (section.arp > 0) {
      const shape = [0, 2, 1, 2, 0, 1, 2, 1];
      const notes = [hz(chord.root, 3), hz(chord.third, 3), hz(chord.fifth, 3)];
      for (let step = 0; step < 8; step += 1) {
        const freq = notes[shape[step] as number] as number;
        add(
          at + step * (BEAT / 2),
          0.4,
          (t) => pluck(t, freq, 0.1) * section.arp * 0.28,
          step % 2 === 0 ? -0.35 : 0.35,
        );
      }
    }

    if (section.lead > 0 && bar % 2 === 0) {
      const freq = hz(chord.fifth, 4);
      add(at, BAR, (t) => pluck(t, freq, 0.55) * section.lead * 0.16, 0);
    }

    // A riser into every section change.
    const next = SECTIONS.find((s) => s.from === bar + 1);
    if (next) add(at, BAR, (t) => riser(t, BAR) * 0.28);
  }

  // Sidechain: the bass and pad get out of the kick's way, which is what makes a
  // four-to-the-floor breathe instead of sounding like a wall.
  const duck = new Float32Array(frames).fill(1);
  for (const at of kicks) {
    const from = Math.max(0, Math.floor(at * RATE));
    const to = Math.min(frames, Math.ceil((at + 0.26) * RATE));
    for (let i = from; i < to; i += 1) {
      const t = (i - at * RATE) / RATE;
      duck[i] = Math.min(duck[i] as number, 0.42 + 0.58 * (1 - decay(t, 0.09)));
    }
  }

  // Fades, so the track can be laid under the reel without a click at either end.
  const fadeIn = 1.4 * RATE;
  const fadeOut = 3.4 * RATE;
  for (let i = 0; i < frames; i += 1) {
    const d = duck[i] as number;
    const edge = Math.min(1, i / fadeIn) * Math.min(1, Math.max(0, (frames - i) / fadeOut)) ** 1.4;
    // A soft knee rather than a hard clip: driven hard enough that the quiet half of
    // every bar comes up with the loud half, which is what makes a track sit under a
    // picture instead of disappearing between the kicks.
    const shape = (value: number) => Math.tanh(value * 1.55) * 0.88;
    left[i] = shape((left[i] as number) * d) * edge;
    right[i] = shape((right[i] as number) * d) * edge;
  }

  /**
   * The last thing before the file: a shelf off the very top and the rumble off the
   * bottom. A reel is watched on laptop speakers and in a hall, and both are happier
   * with a track that stops a little short of the extremes than with one that fills them.
   */
  const lowPass = (channel: Float32Array, hz: number) => {
    const a = 1 - Math.exp((-TAU * hz) / RATE);
    let state = 0;
    for (let i = 0; i < channel.length; i += 1) {
      state += a * ((channel[i] as number) - state);
      channel[i] = state;
    }
  };
  const highPass = (channel: Float32Array, hz: number) => {
    const a = 1 - Math.exp((-TAU * hz) / RATE);
    let state = 0;
    for (let i = 0; i < channel.length; i += 1) {
      state += a * ((channel[i] as number) - state);
      channel[i] = (channel[i] as number) - state;
    }
  };
  for (const channel of [left, right]) {
    // Twice, for a steeper slope than one pole gives.
    lowPass(channel, 11_500);
    lowPass(channel, 13_500);
    highPass(channel, 28);
  }
  return [left, right];
}

function toWav(channels: readonly Float32Array[]): Buffer {
  const frames = channels[0]?.length ?? 0;
  const bytes = frames * channels.length * 2;
  const buffer = Buffer.alloc(44 + bytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + bytes, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels.length, 22);
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * channels.length * 2, 28);
  buffer.writeUInt16LE(channels.length * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(bytes, 40);
  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (const channel of channels) {
      const value = Math.max(-1, Math.min(1, channel[i] as number));
      buffer.writeInt16LE(Math.round(value * 32_767), offset);
      offset += 2;
    }
  }
  return buffer;
}

async function main() {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not resolve a binary');
  console.log(`writing ${LENGTH.toFixed(1)}s of music at ${BPM} bpm…`);
  await mkdir('public/audio', { recursive: true });
  const wav = 'out/reel-music.wav';
  await mkdir('out', { recursive: true });
  await writeFile(wav, toWav(render()));

  const out = 'public/audio/reel.m4a';
  await rm(out, { force: true });
  await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    wav,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    String(RATE),
    out,
  ]);
  if (!process.argv.includes('--wav')) await rm(wav, { force: true });
  console.log(`music -> ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
