/**
 * The pointer, drawn back over a take.
 *
 * Headless Chrome records no cursor, so the reel replays the path the scene script
 * actually drove. The shape is a rounded navigation arrow — slate-violet body, a thick
 * white rim, a wide lavender halo — the pointer of a modern design tool rather than the
 * system caret. A press squeezes it and sends a soft ring out from the tip.
 */
import { interpolate } from 'remotion';

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

/** Rounded arrow in a 24-unit box, tip at the top-left, a shallow notch at the back. */
const ARROW =
  'M4.6 3.1C3.7 2.7 2.7 3.7 3.1 4.6L9.4 20.1C9.8 21.1 11.2 21.1 11.6 20.1L13.4 14.9C13.5 14.4 13.9 14.1 14.3 13.9L20.1 11.7C21.1 11.3 21.1 9.9 20.1 9.5Z';

const TIP = { x: 3.4 / 24, y: 3.4 / 24 } as const;

export function Cursor({ x, y, press, sincePress, opacity = 1, scale = 1 }: CursorProps) {
  const size = 40 * scale;
  const dip = interpolate(press, [0, 1], [1, 0.86]);
  const ringAge = sincePress ?? 99;
  const ringOn = ringAge >= 0 && ringAge < 0.55;
  const ringSize = interpolate(ringAge, [0, 0.55], [size * 0.4, size * 2.4], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const ringFade = interpolate(ringAge, [0, 0.1, 0.55], [0.9, 0.55, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const halo = size * 2.3;
  const haloBoost = interpolate(press, [0, 1], [1, 1.25]);

  return (
    <div
      style={{
        position: 'absolute',
        left: x - TIP.x * size,
        top: y - TIP.y * size,
        opacity,
        pointerEvents: 'none',
        zIndex: 60,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: size * 0.45 - halo / 2,
          top: size * 0.45 - halo / 2,
          width: halo,
          height: halo,
          borderRadius: '50%',
          background:
            'radial-gradient(circle, rgba(178,168,255,0.55) 0%, rgba(178,168,255,0.26) 38%, rgba(178,168,255,0) 70%)',
          transform: `scale(${haloBoost})`,
        }}
      />
      {ringOn ? (
        <div
          style={{
            position: 'absolute',
            left: TIP.x * size - ringSize / 2,
            top: TIP.y * size - ringSize / 2,
            width: ringSize,
            height: ringSize,
            borderRadius: '50%',
            border: `${Math.max(1.5, size * 0.06)}px solid rgba(196,188,255,0.95)`,
            background: 'rgba(178,168,255,0.12)',
            opacity: ringFade,
          }}
        />
      ) : null}
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        style={{
          display: 'block',
          position: 'relative',
          overflow: 'visible',
          transform: `scale(${dip})`,
          transformOrigin: `${(TIP.x * size).toFixed(2)}px ${(TIP.y * size).toFixed(2)}px`,
          filter: 'drop-shadow(0 2px 3px rgba(30,26,70,0.35))',
        }}
        aria-hidden
      >
        <title>pointer</title>
        <defs>
          <linearGradient id="promo-cursor-body" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#8a86b8" />
            <stop offset="100%" stopColor="#5d5a8c" />
          </linearGradient>
        </defs>
        <path
          d={ARROW}
          fill="url(#promo-cursor-body)"
          stroke="#ffffff"
          strokeWidth={2.2}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
