/**
 * The cuts between shots.
 *
 * Three moves carry the whole reel: a whip, which throws one screen off and brings the
 * next in behind it; a push through, where the outgoing frame keeps growing until the
 * next one is already there; and a struck flash for the hardest cuts. Each is written as
 * a Remotion transition presentation so the overlap maths stays in one place.
 */
import type {
  TransitionPresentation,
  TransitionPresentationComponentProps,
} from '@remotion/transitions';
import type { ReactNode } from 'react';
import { AbsoluteFill, interpolate } from 'remotion';
import { color } from '../theme.ts';

type Direction = 'left' | 'right' | 'up' | 'down';

interface WhipProps {
  readonly direction: Direction;
  /** Remotion carries presentation props as a bag; this keeps the shape assignable. */
  readonly [key: string]: unknown;
}

const axis = (direction: Direction) => (direction === 'left' || direction === 'right' ? 'X' : 'Y');
const sign = (direction: Direction) => (direction === 'left' || direction === 'up' ? -1 : 1);

function WhipPresentation({
  children,
  presentationProgress,
  presentationDirection,
  passedProps,
}: TransitionPresentationComponentProps<WhipProps>) {
  const { direction } = passedProps;
  const p = presentationProgress;
  const leaving = presentationDirection === 'exiting';
  // The two halves are locked together: the incoming frame sits exactly one screen behind
  // the outgoing one for the whole move, so there is never a seam between them. Travelling
  // any further than one screen — an overshoot — is precisely what opens that seam, so the
  // punch comes from the blur and the squeeze instead.
  const travel = sign(direction) * p * 100;
  const move = leaving ? travel : travel - sign(direction) * 100;
  // Speed peaks in the middle of the move, and so does the blur that sells it. A blur
  // fades the edges of what it is applied to, and these two panels meet edge to edge, so
  // it is kept small: any more and the seam between them reads as a dark line.
  const blur = interpolate(p, [0, 0.5, 1], [0, 5, 0]);

  return (
    <AbsoluteFill
      style={{
        transform: `translate${axis(direction)}(${move.toFixed(3)}%)`,
        filter: blur > 0.2 ? `blur(${blur.toFixed(2)}px)` : undefined,
        willChange: 'transform',
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

/** Throws the outgoing screen off one edge and slides the next in behind it. */
export function whip(props: WhipProps): TransitionPresentation<WhipProps> {
  return { component: WhipPresentation, props };
}

interface PushThroughProps {
  readonly depth?: number;
  readonly [key: string]: unknown;
}

function PushThroughPresentation({
  children,
  presentationProgress,
  presentationDirection,
  passedProps,
}: TransitionPresentationComponentProps<PushThroughProps>) {
  const { depth = 0.26 } = passedProps;
  const p = presentationProgress;
  const leaving = presentationDirection === 'exiting';
  const scale = leaving ? 1 + p * depth : 1 - (1 - p) * depth * 0.72;
  const opacity = leaving ? interpolate(p, [0, 0.72], [1, 0]) : interpolate(p, [0.18, 1], [0, 1]);
  const blur = leaving ? interpolate(p, [0, 1], [0, 7]) : interpolate(p, [0, 1], [5, 0]);

  return (
    <AbsoluteFill
      style={{
        transform: `scale(${scale.toFixed(4)})`,
        opacity,
        filter: blur > 0.2 ? `blur(${blur.toFixed(2)}px)` : undefined,
        willChange: 'transform, opacity',
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

/** The outgoing frame keeps growing while the next one arrives behind it. */
export function pushThrough(
  props: PushThroughProps = {},
): TransitionPresentation<PushThroughProps> {
  return { component: PushThroughPresentation, props };
}

interface FlashProps {
  readonly tint?: string;
  readonly [key: string]: unknown;
}

function FlashPresentation({
  children,
  presentationProgress,
  presentationDirection,
  passedProps,
}: TransitionPresentationComponentProps<FlashProps>) {
  const p = presentationProgress;
  const leaving = presentationDirection === 'exiting';
  const veil = interpolate(p, [0, 0.5, 1], [0, 0.92, 0]);
  return (
    <AbsoluteFill
      style={{
        opacity: leaving
          ? interpolate(p, [0.4, 0.62], [1, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })
          : 1,
        transform: `scale(${leaving ? 1 + p * 0.05 : 1.05 - p * 0.05})`,
      }}
    >
      {children}
      {leaving ? null : (
        <AbsoluteFill style={{ backgroundColor: passedProps.tint ?? color.white, opacity: veil }} />
      )}
    </AbsoluteFill>
  );
}

/** A struck cut: the frame is wiped out by light and the next one is already there. */
export function flash(props: FlashProps = {}): TransitionPresentation<FlashProps> {
  return { component: FlashPresentation, props };
}

/** Keeps a shot's content out of the transition's transform when it must stay put. */
export function Static({ children }: { children: ReactNode }) {
  return <AbsoluteFill>{children}</AbsoluteFill>;
}
