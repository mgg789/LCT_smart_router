/**
 * A camera over a piece of footage.
 *
 * Keyframes are written in the coordinates of the take itself — "put the point 78% across
 * and 6% down in the middle of the frame, at 1.6x" — so a shot can be aimed at a button
 * or a corner of the dashboard without counting output pixels. Between keyframes the
 * move is eased, and the speed it reaches feeds a small blur, which is what stops a fast
 * push from reading as a jump.
 */
import type { CSSProperties } from 'react';
import { interpolate } from 'remotion';
import { EASE } from '../theme.ts';

export interface CameraKey {
  /** Seconds from the start of the shot. */
  readonly at: number;
  /** 1 frames the whole take; 1.8 is a close push. */
  readonly scale: number;
  /** Focal point in the take's own normalised coordinates. */
  readonly cx: number;
  readonly cy: number;
  readonly ease?: readonly [number, number, number, number];
}

const bezier = (points: readonly [number, number, number, number]) => {
  const [x1, y1, x2, y2] = points;
  // Newton's method on the cubic's x, then read its y — enough passes for 60 fps.
  return (t: number): number => {
    let guess = t;
    for (let i = 0; i < 6; i += 1) {
      const x = 3 * (1 - guess) ** 2 * guess * x1 + 3 * (1 - guess) * guess ** 2 * x2 + guess ** 3;
      const dx =
        3 * (1 - guess) ** 2 * x1 + 6 * (1 - guess) * guess * (x2 - x1) + 3 * guess ** 2 * (1 - x2);
      if (Math.abs(dx) < 1e-6) break;
      guess -= (x - t) / dx;
      guess = Math.min(1, Math.max(0, guess));
    }
    return 3 * (1 - guess) ** 2 * guess * y1 + 3 * (1 - guess) * guess ** 2 * y2 + guess ** 3;
  };
};

export interface CameraState {
  readonly scale: number;
  readonly cx: number;
  readonly cy: number;
  /** Pixels per second the frame is travelling, used for the speed blur. */
  readonly speed: number;
}

/** Resolves the keyframes at a moment, with the neighbouring sample for velocity. */
export function cameraAt(keys: readonly CameraKey[], seconds: number): CameraState {
  if (keys.length === 0) return { scale: 1, cx: 0.5, cy: 0.5, speed: 0 };
  const sample = (time: number) => {
    const first = keys[0] as CameraKey;
    if (time <= first.at) return { scale: first.scale, cx: first.cx, cy: first.cy };
    const last = keys[keys.length - 1] as CameraKey;
    if (time >= last.at) return { scale: last.scale, cx: last.cx, cy: last.cy };
    for (let i = 0; i < keys.length - 1; i += 1) {
      const a = keys[i] as CameraKey;
      const b = keys[i + 1] as CameraKey;
      if (time >= a.at && time <= b.at) {
        const span = b.at - a.at;
        const raw = span > 0 ? (time - a.at) / span : 1;
        const eased = bezier(b.ease ?? EASE)(raw);
        return {
          scale: a.scale + (b.scale - a.scale) * eased,
          cx: a.cx + (b.cx - a.cx) * eased,
          cy: a.cy + (b.cy - a.cy) * eased,
        };
      }
    }
    return { scale: last.scale, cx: last.cx, cy: last.cy };
  };

  const now = sample(seconds);
  const step = 1 / 60;
  const before = sample(Math.max(0, seconds - step));
  const travel =
    Math.hypot((now.cx - before.cx) * 1920, (now.cy - before.cy) * 1080) * now.scale +
    Math.abs(now.scale - before.scale) * 900;
  return { ...now, speed: travel / step };
}

/**
 * The transform that puts the camera's focal point in the middle of the output.
 *
 * `element` is the size the footage is laid out at — which is the size it was filmed at,
 * so a push samples original pixels — and `output` is the frame it has to land in. The
 * two differ, and using one for the other slides every shot off centre.
 */
export function cameraTransform(
  state: CameraState,
  element: { width: number; height: number },
  output: { width: number; height: number } = element,
): CSSProperties {
  const width = state.scale * element.width;
  const height = state.scale * element.height;
  // A focal point near an edge would push the frame past the footage and show the stage
  // through it. The camera stops at the edge instead, the way a real one would.
  const clamp = (value: number, span: number, view: number) =>
    span <= view ? (view - span) / 2 : Math.min(0, Math.max(view - span, value));
  const tx = clamp(output.width / 2 - state.cx * width, width, output.width);
  const ty = clamp(output.height / 2 - state.cy * height, height, output.height);
  const blur = interpolate(state.speed, [900, 6400], [0, 6.5], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return {
    transformOrigin: '0 0',
    transform: `translate3d(${tx.toFixed(3)}px, ${ty.toFixed(3)}px, 0) scale(${state.scale.toFixed(4)})`,
    filter: blur > 0.15 ? `blur(${blur.toFixed(2)}px)` : undefined,
    willChange: 'transform',
  };
}

/** A still camera, for shots that simply present the take. */
export const STILL: readonly CameraKey[] = [{ at: 0, scale: 1, cx: 0.5, cy: 0.5 }];
