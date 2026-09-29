/**
 * The marker layer: circles, arrows, underlines and notes drawn over a shot as if
 * someone were presenting it on a flipchart.
 *
 * Marks are written in the take's own coordinates and follow the camera, so a circle
 * stays on the button it circles while the shot pushes in. Every stroke is drawn on,
 * held, and wiped off; nothing here ever covers the product for long.
 */
import type { ReactNode } from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { shot } from '../footage.ts';
import { font, HEIGHT, MARKER, WIDTH } from '../theme.ts';
import { type CameraKey, cameraAt, STILL } from './Camera.tsx';

export interface Point {
  readonly x: number;
  readonly y: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Deterministic wobble, so a stroke looks drawn by hand and is the same every render. */
function wobble(seed: number, index: number): number {
  const v = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
}

/**
 * Where a point of a full-frame desk take lands on the output at a moment.
 *
 * Mirrors `Footage`'s own fit and `cameraTransform`'s edge clamp, so a mark lands
 * where the pixel it names is actually drawn.
 */
export function deskPoint(
  scene: string,
  camera: readonly CameraKey[],
  seconds: number,
  p: Point,
): Point {
  const entry = shot(scene);
  const cam = cameraAt(camera, seconds);
  const scale = cam.scale * (WIDTH / entry.width) * 1.03;
  const width = scale * entry.width;
  const height = scale * entry.height;
  const clamp = (value: number, span: number, view: number) =>
    span <= view ? (view - span) / 2 : Math.min(0, Math.max(view - span, value));
  const tx = clamp(WIDTH / 2 - cam.cx * width, width, WIDTH);
  const ty = clamp(HEIGHT / 2 - cam.cy * height, height, HEIGHT);
  return { x: tx + p.x * width, y: ty + p.y * height };
}

/** Where a point of a phone take lands, for a phone drawn by `PhoneFootage`. */
export function phonePoint(
  scene: string,
  camera: readonly CameraKey[],
  seconds: number,
  p: Point,
  phone: { height: number; x?: number; y?: number },
): Point {
  const entry = shot(scene);
  const cam = cameraAt(camera, seconds);
  const screenWidth = (phone.height * entry.width) / entry.height;
  const centreX = (phone.x ?? WIDTH / 2) - (cam.cx - 0.5) * screenWidth * cam.scale;
  const centreY = (phone.y ?? HEIGHT / 2) - (cam.cy - 0.5) * phone.height * cam.scale;
  return {
    x: centreX + (p.x - 0.5) * screenWidth * cam.scale,
    y: centreY + (p.y - 0.5) * phone.height * cam.scale,
  };
}

interface Timing {
  /** Frame the stroke starts drawing. */
  readonly at: number;
  /** Frames to draw it on. */
  readonly draw?: number;
  /** Frames it stays after it is drawn. */
  readonly hold?: number;
}

function useStroke({ at, draw = 16, hold = 70 }: Timing): { drawn: number; alpha: number } {
  const frame = useCurrentFrame();
  const drawn = easeOut(clamp01((frame - at) / draw));
  const out = clamp01((frame - at - draw - hold) / 12);
  return { drawn, alpha: frame < at ? 0 : 1 - out };
}

function Svg({ children, alpha }: { children: ReactNode; alpha: number }) {
  if (alpha <= 0) return null;
  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: alpha, zIndex: 70 }}
      aria-hidden
    >
      <title>sketch</title>
      {children}
    </svg>
  );
}

const strokeProps = (color: string, width: number, drawn: number) =>
  ({
    fill: 'none',
    stroke: color,
    strokeWidth: width,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    pathLength: 1,
    strokeDasharray: 1,
    strokeDashoffset: 1 - drawn,
  }) as const;

/** A loose loop around a point, overshooting its own start the way a pen does. */
export function Loop({
  centre,
  rx,
  ry,
  color = MARKER,
  width = 5,
  seed = 1,
  ...timing
}: Timing & {
  readonly centre: Point;
  readonly rx: number;
  readonly ry: number;
  readonly color?: string;
  readonly width?: number;
  readonly seed?: number;
}) {
  const { drawn, alpha } = useStroke(timing);
  const steps = 72;
  const turn = 1.12;
  const tilt = wobble(seed, 99) * 0.12;
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = -Math.PI * 0.62 + (i / steps) * Math.PI * 2 * turn;
    const drift = 1 + wobble(seed, Math.floor(i / 9)) * 0.045 + (i / steps) * 0.06;
    const x = Math.cos(a) * rx * drift;
    const y = Math.sin(a) * ry * drift;
    const rotatedX = x * Math.cos(tilt) - y * Math.sin(tilt);
    const rotatedY = x * Math.sin(tilt) + y * Math.cos(tilt);
    points.push(`${(centre.x + rotatedX).toFixed(1)},${(centre.y + rotatedY).toFixed(1)}`);
  }
  return (
    <Svg alpha={alpha}>
      <path d={`M${points.join(' L')}`} {...strokeProps(color, width, drawn)} />
    </Svg>
  );
}

/** A slightly wavy stroke under a word or a number. */
export function Underline({
  from,
  to,
  color = MARKER,
  width = 5,
  seed = 2,
  ...timing
}: Timing & {
  readonly from: Point;
  readonly to: Point;
  readonly color?: string;
  readonly width?: number;
  readonly seed?: number;
}) {
  const { drawn, alpha } = useStroke(timing);
  const steps = 18;
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t + Math.sin(t * Math.PI * 3 + seed) * 3 + wobble(seed, i) * 1.4;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return (
    <Svg alpha={alpha}>
      <path d={`M${points.join(' L')}`} {...strokeProps(color, width, drawn)} />
    </Svg>
  );
}

/** A curved arrow from a note to what it names. `bend` bows it to one side. */
export function Arrow({
  from,
  to,
  bend = 0.25,
  color = MARKER,
  width = 5,
  ...timing
}: Timing & {
  readonly from: Point;
  readonly to: Point;
  readonly bend?: number;
  readonly color?: string;
  readonly width?: number;
}) {
  const { drawn, alpha } = useStroke(timing);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const control = { x: from.x + dx / 2 - dy * bend, y: from.y + dy / 2 + dx * bend };
  const angle = Math.atan2(to.y - control.y, to.x - control.x);
  const head = 22;
  const wing = (side: number) => ({
    x: to.x - Math.cos(angle + side * 0.5) * head,
    y: to.y - Math.sin(angle + side * 0.5) * head,
  });
  const left = wing(1);
  const right = wing(-1);
  const headDrawn = clamp01((drawn - 0.82) / 0.18);
  return (
    <Svg alpha={alpha}>
      <path
        d={`M${from.x},${from.y} Q${control.x},${control.y} ${to.x},${to.y}`}
        {...strokeProps(color, width, clamp01(drawn / 0.82))}
      />
      <path
        d={`M${left.x},${left.y} L${to.x},${to.y} L${right.x},${right.y}`}
        {...strokeProps(color, width, headDrawn)}
      />
    </Svg>
  );
}

/** A handwritten note, written left to right. */
export function Note({
  at,
  hold = 70,
  children,
  position,
  size = 46,
  color = MARKER,
  rotate = -3,
  align = 'left',
}: {
  readonly at: number;
  readonly hold?: number;
  readonly children: ReactNode;
  readonly position: Point;
  readonly size?: number;
  readonly color?: string;
  readonly rotate?: number;
  readonly align?: 'left' | 'centre' | 'right';
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const write = easeOut(clamp01((frame - at) / (fps * 0.45)));
  const out = clamp01((frame - at - fps * 0.45 - hold) / 12);
  if (frame < at || out >= 1) return null;
  const shift = align === 'left' ? '0%' : align === 'centre' ? '-50%' : '-100%';
  // Positioned by a composited transform, not left/top: a note riding a moving camera
  // would otherwise snap to whole pixels every frame and shimmer.
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: `translate3d(${position.x.toFixed(2)}px, ${position.y.toFixed(2)}px, 0) translate(${shift}, -50%) rotate(${rotate}deg)`,
        transformOrigin: '0 50%',
        willChange: 'transform',
        fontFamily: font.hand,
        fontWeight: 700,
        fontSize: size,
        lineHeight: 1,
        color,
        whiteSpace: 'nowrap',
        clipPath: `inset(-20% ${((1 - write) * 100).toFixed(2)}% -20% -4%)`,
        opacity: 1 - out,
        zIndex: 71,
        pointerEvents: 'none',
      }}
    >
      {children}
    </div>
  );
}

/** Maps take coordinates of a desk shot to output pixels at the current frame. */
export function useDeskMap(scene: string, camera: readonly CameraKey[] = STILL) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (x: number, y: number): Point => deskPoint(scene, camera, frame / fps, { x, y });
}

/** Maps take coordinates of a phone shot to output pixels at the current frame. */
export function usePhoneMap(
  scene: string,
  camera: readonly CameraKey[],
  phone: { height: number; x?: number; y?: number },
) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (x: number, y: number): Point => phonePoint(scene, camera, frame / fps, { x, y }, phone);
}
