/**
 * The cards between sections.
 *
 * Each one is a short, designed beat rather than a title over black: its own palette,
 * its own abstraction, its own way of arriving. What they share is the grammar — a
 * ground that moves, a figure that draws itself, a word that lands last — so five very
 * different frames still read as one film.
 *
 * Everything here is deterministic: the only source of variation is `rand`, a hash of a
 * seed, so a re-render produces the identical frame.
 */
import type { CSSProperties, ReactNode } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { color, EASE_SNAP, font, HEIGHT, WIDTH } from '../theme.ts';
import { ease } from './Type.tsx';

/** A stable number in [0,1) for an integer seed. */
function rand(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** Progress of a stage that starts at `delay` and runs for `length` frames. */
const stage = (frame: number, delay: number, length: number) =>
  ease(clamp01((frame - delay) / length));

// ---------------------------------------------------------------------------
// Shared furniture
// ---------------------------------------------------------------------------

interface ShellProps {
  readonly children: ReactNode;
  /** The wash behind everything, usually a gradient in the card's own hue. */
  readonly wash: string;
  readonly tint: string;
}

/**
 * The stage a card is built on.
 *
 * A card is cut into and out of hard, so the whole thing carries a slow push of its own:
 * the frame is never static, even on a card that lasts under three seconds.
 */
function Shell({ children, wash, tint }: ShellProps) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const inP = ease(clamp01(frame / 18), EASE_SNAP);
  const outP = ease(clamp01((frame - (durationInFrames - 13)) / 13));
  const drift = interpolate(frame, [0, durationInFrames], [1.045, 1.0]);

  return (
    <AbsoluteFill style={{ backgroundColor: color.stage, overflow: 'hidden' }}>
      <AbsoluteFill style={{ background: wash, opacity: interpolate(inP, [0, 1], [0, 1]) }} />
      {/* Grain, so a flat gradient does not band on a dark projector. */}
      <AbsoluteFill
        style={{
          opacity: 0.045,
          mixBlendMode: 'overlay',
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,0.8) 0 1px, rgba(0,0,0,0.8) 1px 2px)',
          backgroundSize: '3px 3px',
          transform: `translate3d(${(frame % 3) - 1}px, ${((frame * 5) % 3) - 1}px, 0)`,
        }}
      />
      <AbsoluteFill
        style={{
          transform: `scale(${(drift * interpolate(outP, [0, 1], [1, 1.06])).toFixed(4)})`,
          transformOrigin: '50% 50%',
          opacity: interpolate(outP, [0, 1], [1, 0]),
        }}
      >
        {children}
      </AbsoluteFill>
      {/* A rim of the card's colour, so the cut out of it carries the hue a beat longer. */}
      <AbsoluteFill
        style={{
          boxShadow: `inset 0 0 ${HEIGHT * 0.22}px ${tint}22`,
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
}

interface WordProps {
  readonly word: string;
  readonly kicker?: string;
  readonly size: number;
  readonly delay?: number;
  readonly style?: CSSProperties;
  readonly kickerColor?: string;
}

/** The word itself: masked up from its own baseline, tracking closing as it lands. */
function Word({ word, kicker, size, delay = 6, style, kickerColor = color.muted }: WordProps) {
  const frame = useCurrentFrame();
  const p = stage(frame, delay, 26);
  const kick = stage(frame, delay + 10, 20);
  const tracking = interpolate(p, [0, 1], [0.15, -0.026]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: HEIGHT * 0.028,
      }}
    >
      {/* The abstraction behind every card runs right through where the word sits, so the
          word brings its own shade with it rather than each card drawing one. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(46% 26% at 50% 50%, rgba(8,9,11,0.86) 0%, rgba(8,9,11,0.5) 52%, rgba(8,9,11,0) 78%)',
          opacity: p,
        }}
      />
      {kicker ? (
        <div style={{ overflow: 'hidden', paddingBottom: HEIGHT * 0.004, zIndex: 1 }}>
          <span
            style={{
              display: 'block',
              transform: `translate3d(0, ${((1 - kick) * 110).toFixed(2)}%, 0)`,
              opacity: kick,
              fontFamily: font.text,
              fontWeight: 700,
              fontSize: HEIGHT * 0.0235,
              letterSpacing: '0.4em',
              textTransform: 'uppercase',
              color: kickerColor,
              whiteSpace: 'nowrap',
            }}
          >
            {kicker}
          </span>
        </div>
      ) : null}
      <div style={{ overflow: 'hidden', paddingBottom: '0.06em', zIndex: 1 }}>
        <span
          style={{
            display: 'block',
            transform: `translate3d(0, ${((1 - p) * 104).toFixed(2)}%, 0)`,
            fontFamily: font.display,
            fontSize: HEIGHT * size,
            lineHeight: 1,
            letterSpacing: `${tracking}em`,
            paddingRight: '0.06em',
            color: color.white,
            whiteSpace: 'nowrap',
            ...style,
          }}
        >
          {word}
        </span>
      </div>
    </div>
  );
}

/** A line that draws itself, given the path's own length. */
function DrawnPath({
  d,
  length,
  progress,
  stroke,
  width,
  dash,
  cap = 'round',
  opacity = 1,
}: {
  d: string;
  length: number;
  progress: number;
  stroke: string;
  width: number;
  dash?: string;
  cap?: 'round' | 'butt';
  opacity?: number;
}) {
  return (
    <path
      d={d}
      fill="none"
      stroke={stroke}
      strokeWidth={width}
      strokeLinecap={cap}
      strokeLinejoin="round"
      opacity={opacity}
      strokeDasharray={dash ?? `${length} ${length}`}
      strokeDashoffset={dash ? undefined : length * (1 - progress)}
    />
  );
}

// ---------------------------------------------------------------------------
// ИНЖЕНЕР — a route drawing itself across the frame, live
// ---------------------------------------------------------------------------

const ROUTE_D =
  'M -60 690 L 250 690 L 330 560 L 560 560 L 660 430 L 980 430 ' +
  'L 1080 300 L 1400 300 L 1490 430 L 1760 430 L 1840 330 L 1990 330';
const ROUTE_LEN = 3050;

export function CardEngineer() {
  const frame = useCurrentFrame();
  const draw = stage(frame, 2, 52);
  const stops = [
    { x: 330, y: 560 },
    { x: 660, y: 430 },
    { x: 1080, y: 300 },
    { x: 1490, y: 430 },
  ];
  // The travelling dot rides the same progress, so it is always at the drawn end.
  const headAt = draw;
  const blink = 0.55 + 0.45 * Math.sin(frame * 0.26);

  return (
    <Shell
      wash="radial-gradient(72% 86% at 24% 76%, rgba(37,99,235,0.30) 0%, rgba(8,9,11,0) 68%), radial-gradient(56% 64% at 82% 18%, rgba(110,197,255,0.16) 0%, rgba(8,9,11,0) 70%)"
      tint="#6ec5ff"
    >
      {/* The ground: a field of measure marks, sliding as if the map were panning. */}
      <AbsoluteFill
        style={{
          opacity: 0.16,
          backgroundImage:
            'linear-gradient(90deg, rgba(110,197,255,0.5) 1px, transparent 1px), linear-gradient(0deg, rgba(110,197,255,0.35) 1px, transparent 1px)',
          backgroundSize: '96px 96px',
          transform: `translate3d(${(-frame * 0.9).toFixed(1)}px, ${(-frame * 0.42).toFixed(1)}px, 0)`,
          maskImage: 'radial-gradient(70% 70% at 50% 50%, #000 20%, transparent 78%)',
          WebkitMaskImage: 'radial-gradient(70% 70% at 50% 50%, #000 20%, transparent 78%)',
        }}
      />

      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ position: 'absolute', inset: 0 }}
        aria-hidden
      >
        <title>route</title>
        {/* The chord first, dashed, the way the product draws an edge it has no road for. */}
        <DrawnPath
          d={ROUTE_D}
          length={ROUTE_LEN}
          progress={1}
          stroke="rgba(110,197,255,0.30)"
          width={3}
          dash="14 18"
        />
        <DrawnPath
          d={ROUTE_D}
          length={ROUTE_LEN}
          progress={draw}
          stroke="#6ec5ff"
          width={7}
          opacity={0.9}
        />
        {stops.map((stop, index) => {
          const on = clamp01((draw - (0.18 + index * 0.2)) * 9);
          return (
            <g key={`${stop.x}-${stop.y}`} opacity={on}>
              <circle
                cx={stop.x}
                cy={stop.y}
                r={13 + (1 - on) * 26}
                fill="none"
                stroke="#6ec5ff"
                strokeWidth={2.5}
                opacity={0.55}
              />
              <circle cx={stop.x} cy={stop.y} r={9} fill={color.stage} />
              <circle cx={stop.x} cy={stop.y} r={9} fill="none" stroke="#6ec5ff" strokeWidth={4} />
            </g>
          );
        })}
        {/* The head of the line: where the engineer is right now. */}
        <g opacity={headAt > 0.02 && headAt < 0.995 ? 1 : 0}>
          <circle
            cx={0}
            cy={0}
            r={26}
            fill="rgba(110,197,255,0.22)"
            style={{
              transform: `translate(${interpolate(headAt, [0, 1], [-60, 1990])}px, ${interpolate(headAt, [0, 0.26, 0.52, 0.78, 1], [690, 560, 430, 300, 330])}px)`,
            }}
          />
        </g>
      </svg>

      {/* A live badge, because the point of this app is that it is happening now. */}
      <div
        style={{
          position: 'absolute',
          left: WIDTH * 0.5,
          top: HEIGHT * 0.245,
          transform: 'translateX(-50%)',
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 20px',
          borderRadius: 999,
          background: 'rgba(110,197,255,0.12)',
          boxShadow: 'inset 0 0 0 1px rgba(110,197,255,0.4)',
          opacity: stage(frame, 22, 18),
        }}
      >
        <span
          style={{
            width: 11,
            height: 11,
            borderRadius: '50%',
            background: '#ff4d5e',
            opacity: blink,
            boxShadow: `0 0 ${10 + blink * 12}px rgba(255,77,94,0.8)`,
          }}
        />
        <span
          style={{
            fontFamily: font.text,
            fontWeight: 700,
            fontSize: HEIGHT * 0.019,
            letterSpacing: '0.3em',
            color: '#cbe8ff',
          }}
        >
          НА ЛИНИИ
        </span>
      </div>

      <Word word="ИНЖЕНЕР" kicker="LIVE-приложение" size={0.175} delay={8} kickerColor="#8fcdff" />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// КЛИЕНТ — a request lands, and the cycle closes around it
// ---------------------------------------------------------------------------

const CYCLE_STEPS = ['РАССКАЗ', 'ЗАЯВКА', 'ПЛАН', 'ВИЗИТ', 'ОТЧЁТ'] as const;

export function CardClient() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const radius = HEIGHT * 0.355;
  const arc = stage(frame, 4, 56);
  const spin = interpolate(frame, [0, durationInFrames], [-14, 8]);

  return (
    <Shell
      wash="radial-gradient(64% 76% at 50% 50%, rgba(47,158,68,0.26) 0%, rgba(8,9,11,0) 70%), radial-gradient(48% 40% at 14% 84%, rgba(110,231,168,0.14) 0%, rgba(8,9,11,0) 72%)"
      tint="#6ee7a8"
    >
      {/* Ripples out of the middle: the request arriving. */}
      {[0, 1, 2, 3].map((index) => {
        const born = index * 16;
        const age = ((frame - born) % 64) / 64;
        if (frame < born) return null;
        const r = interpolate(age, [0, 1], [HEIGHT * 0.05, HEIGHT * 0.62]);
        return (
          <div
            key={index}
            style={{
              position: 'absolute',
              left: cx - r,
              top: cy - r,
              width: r * 2,
              height: r * 2,
              borderRadius: '50%',
              border: '1.5px solid rgba(110,231,168,0.5)',
              opacity: interpolate(age, [0, 0.12, 1], [0, 0.6, 0]),
            }}
          />
        );
      })}

      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ position: 'absolute', inset: 0, transform: `rotate(${spin.toFixed(2)}deg)` }}
        aria-hidden
      >
        <title>cycle</title>
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="rgba(110,231,168,0.18)"
          strokeWidth={2}
          strokeDasharray="6 12"
        />
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="#6ee7a8"
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={`${2 * Math.PI * radius}`}
          strokeDashoffset={2 * Math.PI * radius * (1 - arc * 0.94)}
          transform={`rotate(-96 ${cx} ${cy})`}
        />
        {CYCLE_STEPS.map((label, index) => {
          const angle = (-96 + (index * 360) / CYCLE_STEPS.length) * (Math.PI / 180);
          const px = cx + Math.cos(angle) * radius;
          const py = cy + Math.sin(angle) * radius;
          const on = clamp01((arc - index / CYCLE_STEPS.length) * 7);
          return (
            <g key={label} opacity={on}>
              <circle cx={px} cy={py} r={14} fill={color.stage} />
              <circle cx={px} cy={py} r={14} fill="none" stroke="#6ee7a8" strokeWidth={5} />
            </g>
          );
        })}
      </svg>

      {/* The step names ride outside the ring, upright — a rotated label is unreadable. */}
      {CYCLE_STEPS.map((label, index) => {
        const angle = (-96 + (index * 360) / CYCLE_STEPS.length + spin) * (Math.PI / 180);
        const px = cx + Math.cos(angle) * (radius + HEIGHT * 0.072);
        const py = cy + Math.sin(angle) * (radius + HEIGHT * 0.072);
        const on = clamp01((arc - index / CYCLE_STEPS.length) * 7);
        return (
          <span
            key={label}
            style={{
              position: 'absolute',
              left: px,
              top: py,
              transform: `translate(-50%, -50%) scale(${interpolate(on, [0, 1], [0.7, 1])})`,
              fontFamily: font.text,
              fontWeight: 700,
              fontSize: HEIGHT * 0.0165,
              letterSpacing: '0.24em',
              color: '#9ff0c4',
              opacity: on * 0.92,
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
        );
      })}

      <Word
        word="КЛИЕНТ"
        kicker="полный цикл заявок"
        size={0.155}
        delay={10}
        kickerColor="#9ff0c4"
      />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// ПЕРЕПЛАН — the day's bars pick themselves up and swap
// ---------------------------------------------------------------------------

const LANES = 7;

export function CardReplan() {
  const frame = useCurrentFrame();
  const swap = stage(frame, 12, 34);
  const laneH = HEIGHT * 0.052;
  const gap = HEIGHT * 0.028;
  const top = HEIGHT / 2 - ((LANES - 1) * (laneH + gap)) / 2 - laneH / 2;

  return (
    <Shell
      wash="radial-gradient(64% 72% at 78% 24%, rgba(255,199,44,0.17) 0%, rgba(8,9,11,0) 66%), radial-gradient(48% 56% at 16% 80%, rgba(245,166,35,0.1) 0%, rgba(8,9,11,0) 70%)"
      tint={color.bee}
    >
      {/* Hazard stripes, sliding: the day is being cut and rejoined. Kept to the corners
          and kept faint — the middle of this frame belongs to the word. */}
      <AbsoluteFill
        style={{
          opacity: 0.05,
          backgroundImage: `repeating-linear-gradient(-45deg, ${color.bee} 0 20px, transparent 20px 58px)`,
          transform: `translate3d(${((frame * 1.6) % 78).toFixed(1)}px, 0, 0)`,
          maskImage: 'radial-gradient(58% 58% at 50% 50%, transparent 20%, #000 82%)',
          WebkitMaskImage: 'radial-gradient(58% 58% at 50% 50%, transparent 20%, #000 82%)',
        }}
      />

      {Array.from({ length: LANES }, (_, slot) => slot).map((index) => {
        const seed = rand(index * 3 + 1);
        const fromX = WIDTH * (0.1 + seed * 0.2);
        const width = WIDTH * (0.22 + rand(index * 5 + 2) * 0.42);
        // Every other lane slides the other way, so the frame reshuffles rather than pans.
        const dir = index % 2 === 0 ? 1 : -1;
        const shift = interpolate(swap, [0, 1], [0, dir * WIDTH * (0.05 + seed * 0.13)]);
        const born = stage(frame, 2 + index * 3, 20);
        const y = top + index * (laneH + gap);
        const hot = index === 3;
        return (
          <div
            key={index}
            style={{
              position: 'absolute',
              left: fromX + shift,
              top: y,
              width,
              height: laneH,
              borderRadius: laneH / 2,
              background: hot
                ? `linear-gradient(90deg, ${color.bee} 0%, ${color.beeDeep} 100%)`
                : 'rgba(255,255,255,0.09)',
              boxShadow: hot
                ? `0 0 ${HEIGHT * 0.05}px rgba(255,199,44,0.45)`
                : 'inset 0 0 0 1px rgba(255,255,255,0.1)',
              opacity: born * (hot ? 1 : 0.8),
              transform: `scaleX(${interpolate(born, [0, 1], [0.7, 1])})`,
              transformOrigin: 'left center',
            }}
          />
        );
      })}

      {/* Two arrows trading places over the stack. */}
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ position: 'absolute', inset: 0 }}
        aria-hidden
      >
        <title>reshuffle</title>
        {[
          {
            d: 'M 1420 330 C 1620 330 1620 620 1420 620',
            head: 'M 1452 600 L 1418 621 L 1452 642',
            at: 16,
          },
          {
            d: 'M 470 620 C 270 620 270 330 470 330',
            head: 'M 438 350 L 472 329 L 438 308',
            at: 22,
          },
        ].map((arrow) => {
          const drawn = stage(frame, arrow.at, 30);
          return (
            <g key={arrow.d}>
              <DrawnPath
                d={arrow.d}
                length={760}
                progress={drawn}
                stroke={color.bee}
                width={5}
                opacity={0.8}
              />
              <path
                d={arrow.head}
                fill="none"
                stroke={color.bee}
                strokeWidth={5}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={clamp01((drawn - 0.86) * 7) * 0.9}
              />
            </g>
          );
        })}
      </svg>

      <Word
        word="ПЕРЕПЛАН"
        kicker="реагирует на изменения"
        size={0.135}
        delay={14}
        kickerColor={color.bee}
      />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// AI — a field that thinks
// ---------------------------------------------------------------------------

const AI_SWEEP = `linear-gradient(104deg, ${color.aiFrom} 0%, ${color.aiVia} 46%, ${color.aiTo} 100%)`;

export function CardAi() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const bloom = stage(frame, 0, 40);
  const spin = interpolate(frame, [0, durationInFrames], [0, 150]);

  return (
    <Shell
      wash="radial-gradient(62% 70% at 50% 48%, rgba(201,164,255,0.22) 0%, rgba(8,9,11,0) 72%)"
      tint={color.aiVia}
    >
      {/* The thinking blob: a conic sweep, blurred past recognition. */}
      <div
        style={{
          position: 'absolute',
          left: cx - HEIGHT * 0.46,
          top: cy - HEIGHT * 0.46,
          width: HEIGHT * 0.92,
          height: HEIGHT * 0.92,
          borderRadius: '50%',
          background: `conic-gradient(from ${spin.toFixed(1)}deg, ${color.aiFrom}, ${color.aiVia}, ${color.aiTo}, ${color.aiFrom})`,
          filter: `blur(${HEIGHT * 0.1}px)`,
          opacity: bloom * 0.42,
          transform: `scale(${interpolate(bloom, [0, 1], [0.6, 1])})`,
        }}
      />

      {/* Particles on three orbits — the field the answer is drawn out of. */}
      {Array.from({ length: 26 }, (_, slot) => slot).map((index) => {
        const ring = index % 3;
        const radius = HEIGHT * (0.2 + ring * 0.13);
        const speed = 0.011 + ring * 0.005;
        const angle = rand(index) * Math.PI * 2 + frame * speed * (ring % 2 === 0 ? 1 : -1);
        const size = 3 + rand(index + 40) * 6;
        const born = stage(frame, 4 + index, 22);
        return (
          <div
            key={index}
            style={{
              position: 'absolute',
              left: cx + Math.cos(angle) * radius - size / 2,
              top: cy + Math.sin(angle) * radius * 0.66 - size / 2,
              width: size,
              height: size,
              borderRadius: '50%',
              background: [color.aiFrom, color.aiVia, color.aiTo][ring],
              opacity: born * (0.35 + rand(index + 9) * 0.5),
              boxShadow: `0 0 ${size * 3}px currentColor`,
              color: [color.aiFrom, color.aiVia, color.aiTo][ring],
            }}
          />
        );
      })}

      {/* Two gradient rules, opening away from the word. */}
      {[-1, 1].map((side) => (
        <div
          key={side}
          style={{
            position: 'absolute',
            left: cx,
            top: cy + side * HEIGHT * 0.175,
            width: interpolate(stage(frame, 16, 30), [0, 1], [0, WIDTH * 0.42]),
            height: 2,
            transform: 'translateX(-50%)',
            background: `linear-gradient(90deg, transparent, ${color.aiVia}, transparent)`,
            opacity: 0.8,
          }}
        />
      ))}

      <Word
        word="AI"
        kicker="глубоко интегрированный"
        size={0.3}
        delay={8}
        kickerColor={color.aiVia}
        // No filter on this span: a drop-shadow over a background-clipped fill makes
        // Chrome rasterise the element's box, and the box is what ends up on screen.
        // The glow behind the word is the conic bloom above, which is doing that job.
        style={{
          backgroundImage: AI_SWEEP,
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          color: 'transparent',
        }}
      />
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// КОНТРОЛЬ — the instrument panel
// ---------------------------------------------------------------------------

export function CardControl() {
  const frame = useCurrentFrame();
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const sweep = stage(frame, 6, 44);
  const radius = HEIGHT * 0.3;
  // A three-quarter dial, filled to a deliberately imperfect reading: control is a
  // number you can act on, not a green tick.
  const total = Math.PI * 1.5 * radius;

  return (
    <Shell
      wash="radial-gradient(60% 72% at 50% 46%, rgba(255,255,255,0.09) 0%, rgba(8,9,11,0) 70%), radial-gradient(40% 44% at 82% 80%, rgba(255,199,44,0.13) 0%, rgba(8,9,11,0) 72%)"
      tint={color.white}
    >
      {/* Measurement rules, sliding in from both edges. */}
      {Array.from({ length: 40 }, (_, slot) => slot).map((index) => {
        const p = stage(frame, index * 0.7, 26);
        const long = index % 5 === 0;
        const y = (index / 39) * HEIGHT;
        return (
          <div key={index}>
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: y,
                width: (long ? 54 : 26) * p,
                height: long ? 2 : 1,
                background: long ? color.bee : 'rgba(255,255,255,0.4)',
                opacity: 0.55,
              }}
            />
            <div
              style={{
                position: 'absolute',
                right: 0,
                top: y,
                width: (long ? 54 : 26) * p,
                height: long ? 2 : 1,
                background: long ? color.bee : 'rgba(255,255,255,0.4)',
                opacity: 0.55,
              }}
            />
          </div>
        );
      })}

      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ position: 'absolute', inset: 0 }}
        aria-hidden
      >
        <title>dial</title>
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.1)"
          strokeWidth={14}
          strokeLinecap="round"
          strokeDasharray={`${total} ${total * 3}`}
          transform={`rotate(135 ${cx} ${cy})`}
        />
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={color.bee}
          strokeWidth={14}
          strokeLinecap="round"
          strokeDasharray={`${total * 0.82} ${total * 3}`}
          strokeDashoffset={total * 0.82 * (1 - sweep)}
          transform={`rotate(135 ${cx} ${cy})`}
          opacity={0.92}
        />
        {/* Ticks around the dial, arriving with the sweep. */}
        {Array.from({ length: 25 }, (_, slot) => slot).map((index) => {
          const a = (135 + (index / 24) * 270) * (Math.PI / 180);
          const on = clamp01((sweep - index / 24) * 8);
          const r0 = radius + 18;
          const r1 = radius + (index % 6 === 0 ? 38 : 27);
          return (
            <line
              key={index}
              x1={cx + Math.cos(a) * r0}
              y1={cy + Math.sin(a) * r0}
              x2={cx + Math.cos(a) * r1}
              y2={cy + Math.sin(a) * r1}
              stroke={index % 6 === 0 ? color.bee : 'rgba(255,255,255,0.55)'}
              strokeWidth={index % 6 === 0 ? 3 : 1.6}
              strokeLinecap="round"
              opacity={on}
            />
          );
        })}
      </svg>

      {/* A crosshair through the middle, the way a plan is read off a chart. */}
      {[0, 1].map((axis) => (
        <div
          key={axis}
          style={{
            position: 'absolute',
            left: axis === 0 ? 0 : cx,
            top: axis === 0 ? cy : 0,
            width: axis === 0 ? WIDTH * stage(frame, 10, 34) : 1,
            height: axis === 0 ? 1 : HEIGHT * stage(frame, 14, 34),
            background: 'rgba(255,255,255,0.16)',
          }}
        />
      ))}

      <Word word="КОНТРОЛЬ" kicker="политики и метрики" size={0.125} delay={16} />
    </Shell>
  );
}
