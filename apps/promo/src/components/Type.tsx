/**
 * The reel's typography: a word that arrives rather than appears.
 *
 * Every card is built the same way — a mask that lifts the line into place, a tracking
 * that tightens as it lands — so the cuts between sections feel like one piece of design
 * instead of a set of title cards.
 */
import type { CSSProperties, ReactNode } from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { color, EASE, font } from '../theme.ts';

const ease = (t: number, points: readonly [number, number, number, number] = EASE) => {
  const [x1, y1, x2, y2] = points;
  let g = t;
  for (let i = 0; i < 6; i += 1) {
    const x = 3 * (1 - g) ** 2 * g * x1 + 3 * (1 - g) * g ** 2 * x2 + g ** 3;
    const dx = 3 * (1 - g) ** 2 * x1 + 6 * (1 - g) * g * (x2 - x1) + 3 * g ** 2 * (1 - x2);
    if (Math.abs(dx) < 1e-6) break;
    g = Math.min(1, Math.max(0, g - (x - t) / dx));
  }
  return 3 * (1 - g) ** 2 * g * y1 + 3 * (1 - g) * g ** 2 * y2 + g ** 3;
};

export interface RiseProps {
  readonly children: ReactNode;
  /** Frames from the start of the sequence before the line begins to move. */
  readonly delay?: number;
  readonly duration?: number;
  readonly distance?: number;
  readonly style?: CSSProperties;
}

/** A line that lifts into view from behind its own baseline. */
export function Rise({ children, delay = 0, duration = 26, distance = 0.9, style }: RiseProps) {
  const frame = useCurrentFrame();
  const p = ease(Math.min(1, Math.max(0, (frame - delay) / duration)));
  return (
    <span style={{ display: 'block', overflow: 'hidden', ...style }}>
      <span
        style={{
          display: 'block',
          transform: `translate3d(0, ${(1 - p) * 100 * distance}%, 0)`,
          opacity: interpolate(p, [0, 0.25], [0, 1], { extrapolateRight: 'clamp' }),
        }}
      >
        {children}
      </span>
    </span>
  );
}

export const AI_GRADIENT = `linear-gradient(104deg, ${color.aiFrom} 0%, ${color.aiVia} 46%, ${color.aiTo} 100%)`;

export interface WordCardProps {
  readonly word: string;
  readonly caption?: string;
  readonly kicker?: string;
  readonly gradient?: boolean;
  /** Fraction of the stage height the word's cap height takes. */
  readonly size?: number;
}

/**
 * A full-stage word: the beat between two parts of the story.
 *
 * The word scales down a touch as it settles, so the cut into it lands hard and the cut
 * out of it is already in motion.
 */
export function WordCard({ word, caption, kicker, gradient = false, size = 0.27 }: WordCardProps) {
  const frame = useCurrentFrame();
  const { durationInFrames, height } = useVideoConfig();
  const inP = ease(Math.min(1, frame / 20));
  const outP = ease(Math.min(1, Math.max(0, (frame - (durationInFrames - 14)) / 14)));
  const scale = interpolate(inP, [0, 1], [1.12, 1]) * interpolate(outP, [0, 1], [1, 1.07]);
  const tracking = interpolate(inP, [0, 1], [0.16, -0.028]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: height * 0.022,
        opacity: interpolate(outP, [0, 1], [1, 0]),
      }}
    >
      {kicker ? (
        <Rise delay={4} duration={20}>
          <span
            style={{
              fontFamily: font.text,
              fontWeight: 600,
              fontSize: height * 0.026,
              letterSpacing: '0.42em',
              textTransform: 'uppercase',
              color: color.muted,
            }}
          >
            {kicker}
          </span>
        </Rise>
      ) : null}
      <div
        style={{
          transform: `scale(${scale})`,
          transformOrigin: 'center center',
        }}
      >
        <Rise delay={0} duration={24} distance={1}>
          <span
            style={{
              display: 'block',
              fontFamily: font.display,
              fontSize: height * size,
              lineHeight: 1,
              letterSpacing: `${tracking}em`,
              paddingRight: '0.06em',
              ...(gradient
                ? {
                    backgroundImage: AI_GRADIENT,
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    color: 'transparent',
                  }
                : { color: color.white }),
            }}
          >
            {word}
          </span>
        </Rise>
      </div>
      {caption ? (
        <Rise delay={12} duration={22}>
          <span
            style={{
              fontFamily: font.text,
              fontWeight: 500,
              fontSize: height * 0.031,
              letterSpacing: '-0.01em',
              color: color.muted,
            }}
          >
            {caption}
          </span>
        </Rise>
      ) : null}
    </div>
  );
}

export { ease };
