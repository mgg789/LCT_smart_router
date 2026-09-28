/**
 * The pointer, drawn back over a take.
 *
 * Headless Chrome records no cursor, so the reel replays the path the scene script
 * actually drove: same moments, same places, interpolated up to 60 fps. A press dips the
 * arrow and sends a ring out from the point that was clicked.
 *
 * The shape is the modern arrow — one rounded sweep from tip to tail rather than the
 * old notched Windows caret — filled white, with a soft dark rim so it stays readable
 * over a white dashboard as well as over the dark stage.
 */
import { interpolate } from 'remotion';
import { color } from '../theme.ts';

export interface CursorProps {
  /** Position in output pixels. */
  readonly x: number;
  readonly y: number;
  readonly press: number;
  readonly sincePress: number | null;
  readonly opacity?: number;
  /** Scales the whole pointer, so it stays readable when the camera pushes in. */
  readonly scale?: number;
}

/**
 * Lucide's `mouse-pointer-2` outline, in a 24-unit box with the tip at (4, 4).
 *
 * Every corner is already rounded in the path itself, so the arrow keeps its shape at
 * any size instead of relying on a stroke to soften it.
 */
const ARROW =
  'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58' +
  'a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z';

/** The tip, as a fraction of the drawn box — everything pivots and points from here. */
const TIP = { x: 4.2 / 24, y: 4.2 / 24 } as const;

export function Cursor({ x, y, press, sincePress, opacity = 1, scale = 1 }: CursorProps) {
  const size = 40 * scale;
  const dip = interpolate(press, [0, 1], [1, 0.84]);
  const ringAge = sincePress ?? 99;
  const ringOn = ringAge >= 0 && ringAge < 0.6;
  const ringSize = interpolate(ringAge, [0, 0.6], [18, 118], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const ringFade = interpolate(ringAge, [0, 0.12, 0.6], [0.7, 0.44, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // A short white bloom right under the tip, so a press reads even where the ring is
  // travelling over a busy part of the screen.
  const blot = interpolate(ringAge, [0, 0.22], [0.5, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity,
        pointerEvents: 'none',
        zIndex: 60,
      }}
    >
      {ringOn ? (
        <>
          <div
            style={{
              position: 'absolute',
              left: -ringSize / 2,
              top: -ringSize / 2,
              width: ringSize,
              height: ringSize,
              borderRadius: '50%',
              border: `${Math.max(1.4, 4.2 - ringAge * 5.4)}px solid ${color.bee}`,
              opacity: ringFade,
              boxShadow: `0 0 ${ringSize / 3}px ${color.bee}4d`,
            }}
          />
          {blot > 0.01 ? (
            <div
              style={{
                position: 'absolute',
                left: -size * 0.22,
                top: -size * 0.22,
                width: size * 0.44,
                height: size * 0.44,
                borderRadius: '50%',
                background: `radial-gradient(circle, rgba(255,255,255,${blot.toFixed(3)}) 0%, rgba(255,255,255,0) 70%)`,
              }}
            />
          ) : null}
        </>
      ) : null}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{
          display: 'block',
          transform: `scale(${dip})`,
          transformOrigin: `${(TIP.x * size).toFixed(2)}px ${(TIP.y * size).toFixed(2)}px`,
          filter: 'drop-shadow(0 5px 13px rgba(0,0,0,0.5))',
        }}
        aria-hidden
      >
        <title>pointer</title>
        {/* Rim first, fill over it: the arrow keeps a crisp white body on any screen. */}
        <path
          d={ARROW}
          fill={color.white}
          stroke="rgba(9,10,13,0.55)"
          strokeWidth={1.35}
          strokeLinejoin="round"
          strokeLinecap="round"
          paintOrder="stroke"
        />
      </svg>
    </div>
  );
}
