/**
 * A short line over a shot, for the one thing the picture alone will not say.
 *
 * Used sparingly: the sections carry their own titles, so a caption is here only where
 * the screen is doing something a first-time viewer would otherwise miss — a straight
 * line turning into a road, a form filling itself out of a sentence.
 */
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { color, font } from '../theme.ts';
import { ease } from './Type.tsx';

export interface CaptionProps {
  readonly text: string;
  readonly kicker?: string;
  /** Frames from the start of the shot. */
  readonly at?: number;
  readonly hold?: number;
  readonly align?: 'left' | 'centre';
  /** Over a phone the bottom of the stage is the screen, so the line goes above it. */
  readonly position?: 'bottom' | 'top';
}

export function Caption({
  text,
  kicker,
  at = 0,
  hold = 110,
  align = 'left',
  position = 'bottom',
}: CaptionProps) {
  const frame = useCurrentFrame();
  const { height, width } = useVideoConfig();
  const local = frame - at;
  if (local < -4 || local > hold + 30) return null;

  const enter = ease(Math.min(1, Math.max(0, local / 22)));
  const exit = ease(Math.min(1, Math.max(0, (local - hold) / 20)));
  const opacity = enter * (1 - exit);
  const away = position === 'top' ? -1 : 1;
  const lift = (interpolate(enter, [0, 1], [26, 0]) + interpolate(exit, [0, 1], [0, -14])) * away;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: align === 'left' ? width * 0.063 : 0,
          right: align === 'left' ? undefined : 0,
          ...(position === 'top' ? { top: height * 0.072 } : { bottom: height * 0.082 }),
          display: 'flex',
          flexDirection: 'column',
          alignItems: align === 'left' ? 'flex-start' : 'center',
          gap: height * 0.012,
          opacity,
          transform: `translate3d(0, ${lift.toFixed(2)}px, 0)`,
        }}
      >
        {/* One black slab: no rule, no border, no accent — the line is the whole point,
            and a card with furniture on it competes with the screen behind it. */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: align === 'left' ? 'flex-start' : 'center',
            gap: height * 0.011,
            padding: `${height * 0.036}px ${height * 0.042}px`,
            borderRadius: height * 0.026,
            background: 'rgba(8,9,11,0.9)',
            backdropFilter: 'blur(18px)',
            boxShadow: '0 22px 56px rgba(0,0,0,0.5)',
          }}
        >
          {kicker ? (
            <span
              style={{
                fontFamily: font.text,
                fontWeight: 700,
                fontSize: height * 0.0185,
                letterSpacing: '0.34em',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.58)',
              }}
            >
              {kicker}
            </span>
          ) : null}
          <span
            style={{
              fontFamily: font.text,
              fontWeight: 600,
              fontSize: height * 0.0375,
              letterSpacing: '-0.018em',
              lineHeight: 1.18,
              color: color.white,
            }}
          >
            {text}
          </span>
        </div>
      </div>
    </AbsoluteFill>
  );
}

/** A soft vignette and a whisper of grain, so a bright screen sits in a dark reel. */
export function Grade() {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(78% 68% at 50% 46%, rgba(0,0,0,0) 52%, rgba(0,0,0,0.34) 100%)',
        }}
      />
      <AbsoluteFill
        style={{
          opacity: 0.035,
          mixBlendMode: 'overlay',
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,0.7) 0 1px, rgba(0,0,0,0.7) 1px 2px)',
          backgroundSize: '3px 3px',
          transform: `translate3d(${(frame % 3) - 1}px, ${((frame * 7) % 3) - 1}px, 0)`,
        }}
      />
    </AbsoluteFill>
  );
}
