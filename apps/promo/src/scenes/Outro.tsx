/**
 * The close.
 *
 * It opens on nothing new at all: the same board, at the same size, playing on from the
 * same moment the shot before it left off. There is no cut into this scene and no
 * transition over it — the only thing that happens is that the camera starts backing
 * away, and by the time it stops the screen has turned out to be a laptop on a desk.
 *
 * Holding that illusion is a matter of arithmetic. `Footage` lays a take out at the size
 * it was filmed and lets the camera carry the fit, with three per cent of overscan so a
 * speed blur cannot show the stage through the edge of the frame; the laptop screen
 * below reproduces exactly that, so the first frame here is the previous shot's last
 * frame and not a near miss.
 *
 * The two phone apps swing out from behind the screen, the assistant's mascot pops into
 * the corner they leave free, and the names rise last. Every screen in the shot is still
 * the real app playing — the desk is the only thing drawn.
 */
import type { CSSProperties } from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  OffthreadVideo,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { Grade } from '../components/Caption.tsx';
import { ease } from '../components/Type.tsx';
import { hasShot, mark, shot } from '../footage.ts';
import { color, font, HEIGHT, WIDTH } from '../theme.ts';

/** The overscan `Footage` draws every take with; the laptop has to match it exactly. */
const OVERSCAN = 1.03;

/** First take that was actually filmed, so a missing scene cannot blank the shot. */
function pick(...names: readonly string[]): string {
  const found = names.find((name) => hasShot(name));
  if (!found) throw new Error(`none of these takes exist: ${names.join(', ')}`);
  return found;
}

/** A take inside a rectangle, framed the way `Footage` frames it. */
function Screen({
  scene,
  from,
  width,
  height,
  opacity = 1,
}: {
  scene: string;
  from: number;
  width: number;
  height: number;
  opacity?: number;
}) {
  const { fps } = useVideoConfig();
  const entry = shot(scene);
  const videoW = width * OVERSCAN;
  const videoH = height * OVERSCAN;
  return (
    <OffthreadVideo
      src={staticFile(entry.file)}
      trimBefore={Math.round(Math.max(0, Math.min(from, entry.duration - 1.2)) * fps)}
      muted
      style={{
        position: 'absolute',
        left: (width - videoW) / 2,
        top: (height - videoH) / 2,
        width: videoW,
        height: videoH,
        objectFit: 'cover',
        display: 'block',
        opacity,
      }}
    />
  );
}

/** A phone take in a small device, for the corners. */
function PhoneScreen({ scene, width, height }: { scene: string; width: number; height: number }) {
  const { fps } = useVideoConfig();
  const entry = shot(scene);
  return (
    <OffthreadVideo
      src={staticFile(entry.file)}
      trimBefore={Math.round(Math.max(0, entry.duration - 7) * fps)}
      muted
      style={{ display: 'block', objectFit: 'cover', width, height }}
    />
  );
}

export interface OutroProps {
  /** The take the previous shot ended on — this one keeps playing it. */
  readonly deskScene?: string;
  /** Seconds into that take where the previous shot stopped. */
  readonly deskFrom?: number;
}

export function Outro({ deskScene, deskFrom = 0 }: OutroProps) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const board = deskScene && hasShot(deskScene) ? deskScene : pick('day-end', 'open', 'replan');
  const enginePhone = pick('outro-engineer', 'engineer-day', 'engineer-login');
  const clientPhone = pick('outro-client', 'client');

  /**
   * The plan rebuilding, for the last seconds.
   *
   * The board the day closed on is a finished plan sitting still, and the shot wants to
   * end on the product working. Once the camera is far enough away for the screen to be
   * an object rather than a view, it crosses over to the take where the day is actually
   * being rebuilt — the lines moving, the notice arriving — which at that size is a
   * change of what is on the laptop rather than a cut in the film.
   */
  const rebuild = hasShot('replan') ? 'replan' : null;
  const cross = ease(Math.min(1, Math.max(0, (frame - 150) / 34)));

  // The pull back: the board fills the frame exactly, and settles onto the desk.
  const pull = ease(Math.min(1, frame / 88));
  const screenW = interpolate(pull, [0, 1], [WIDTH, 1000]);
  const screenH = (screenW * HEIGHT) / WIDTH;
  const screenLeft = WIDTH / 2 - screenW / 2;
  const screenTop = interpolate(pull, [0, 1], [0, 150]);
  // The bezel grows out of nothing: at the first frame there is no laptop yet.
  const bezel = interpolate(pull, [0, 1], [0, Math.max(3, 1000 * 0.009)]);
  const deckH = 34 * pull;
  const deckW = screenW * 1.11;

  const springOut = (delay: number) =>
    spring({ frame: frame - delay, fps, config: { damping: 14, mass: 0.9, stiffness: 110 } });

  const leftPhone = springOut(96);
  const rightPhone = springOut(108);
  const mascot = springOut(124);
  const lockup = ease(Math.min(1, Math.max(0, (frame - 146) / 48)));

  const phoneH = 404;
  const phoneW = phoneH * 0.4615;

  const fadeOut = interpolate(frame, [durationInFrames - 28, durationInFrames - 2], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  /** A phone that starts hidden behind the screen and swings out to its corner. */
  const phoneStyle = (progress: number, side: -1 | 1): CSSProperties => {
    const cx = interpolate(progress, [0, 1], [WIDTH / 2 + side * 120, WIDTH / 2 + side * 565]);
    const cy = interpolate(progress, [0, 1], [screenTop + screenH * 0.5, 648]);
    return {
      position: 'absolute',
      left: cx - phoneW / 2,
      top: cy - phoneH / 2,
      width: phoneW,
      height: phoneH,
      transform: `rotate(${side * interpolate(progress, [0, 1], [0, 8])}deg) scale(${interpolate(
        progress,
        [0, 1],
        [0.62, 1],
      )})`,
      opacity: interpolate(progress, [0, 0.18], [0, 1], { extrapolateRight: 'clamp' }),
      zIndex: 3,
    };
  };

  return (
    <AbsoluteFill style={{ backgroundColor: color.stage, overflow: 'hidden', opacity: fadeOut }}>
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(62% 50% at 50% 26%, rgba(255,199,44,0.12) 0%, rgba(8,9,11,0) 68%)',
          opacity: pull,
        }}
      />

      {/* Laptop: the screen in its bezel, then the deck it folds onto. */}
      <div
        style={{
          position: 'absolute',
          left: screenLeft - bezel,
          top: screenTop - bezel,
          width: screenW + bezel * 2,
          height: screenH + bezel * 2,
          padding: bezel,
          borderRadius: bezel * 3,
          background:
            bezel > 0.5 ? 'linear-gradient(150deg, #45484f 0%, #15171b 46%, #2a2d34 100%)' : 'none',
          boxShadow:
            bezel > 0.5
              ? '0 44px 92px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.07), 0 0 160px rgba(255,199,44,0.06)'
              : 'none',
          zIndex: 2,
        }}
      >
        <div
          style={{
            position: 'relative',
            width: screenW,
            height: screenH,
            borderRadius: bezel * 1.6,
            overflow: 'hidden',
            background: color.canvas,
          }}
        >
          {/* `trimBefore` is where the take is entered, once: the sequence's own clock
              carries it forward from there, which is what makes this frame the next
              frame of the shot before rather than a seek to the same place again. */}
          <Screen scene={board} from={deskFrom} width={screenW} height={screenH} />
          {rebuild && cross > 0.001 ? (
            <Screen
              scene={rebuild}
              from={Math.max(0, mark('replan', 'policyPicked', 0) - 150 / fps)}
              width={screenW}
              height={screenH}
              opacity={cross}
            />
          ) : null}
        </div>
      </div>

      {/* The grade the board was carrying a frame ago, let go of as the camera backs off. */}
      {pull < 0.99 ? (
        <AbsoluteFill style={{ opacity: 1 - pull }}>
          <Grade />
        </AbsoluteFill>
      ) : null}

      <div
        style={{
          position: 'absolute',
          left: WIDTH / 2 - deckW / 2,
          top: screenTop + screenH + bezel,
          width: deckW,
          height: deckH,
          background: 'linear-gradient(180deg, #363940 0%, #15171b 100%)',
          clipPath: 'polygon(1.2% 0%, 98.8% 0%, 100% 100%, 0% 100%)',
          borderBottomLeftRadius: deckH * 0.6,
          borderBottomRightRadius: deckH * 0.6,
          boxShadow: '0 26px 54px rgba(0,0,0,0.6)',
          zIndex: 2,
        }}
      />

      {/* The two phone apps, swinging out from behind the screen. */}
      {(
        [
          [leftPhone, -1 as const, enginePhone],
          [rightPhone, 1 as const, clientPhone],
        ] as const
      ).map(([progress, side, scene]) => (
        <div key={scene} style={phoneStyle(progress, side)}>
          <div
            style={{
              width: '100%',
              height: '100%',
              borderRadius: phoneH * 0.072,
              padding: phoneH * 0.014,
              background: 'linear-gradient(160deg, #3c3f47 0%, #14161a 40%, #262930 100%)',
              boxShadow: '0 26px 58px rgba(0,0,0,0.66), 0 0 0 1px rgba(255,255,255,0.08)',
            }}
          >
            <div
              style={{
                width: '100%',
                height: '100%',
                borderRadius: phoneH * 0.058,
                overflow: 'hidden',
                background: color.canvas,
              }}
            >
              <PhoneScreen
                scene={scene}
                width={phoneW - phoneH * 0.028}
                height={phoneH - phoneH * 0.028}
              />
            </div>
          </div>
        </div>
      ))}

      {/* The assistant, in the corner the phones left free. */}
      <div
        style={{
          position: 'absolute',
          left: WIDTH * 0.79,
          top: 118,
          width: 186,
          height: 186,
          transform: `scale(${interpolate(mascot, [0, 1], [0.18, 1])}) rotate(${interpolate(
            mascot,
            [0, 1],
            [-26, 0],
          )}deg)`,
          transformOrigin: 'center bottom',
          opacity: interpolate(mascot, [0, 0.2], [0, 1], { extrapolateRight: 'clamp' }),
          filter: 'drop-shadow(0 22px 42px rgba(0,0,0,0.55))',
          zIndex: 4,
        }}
      >
        <Img
          src={staticFile('brand/ai-kolobok.png')}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      </div>

      {/* The names, rising last, clear of the desk. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 56,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
          transform: `translate3d(0, ${interpolate(lockup, [0, 1], [110, 0])}px, 0)`,
          opacity: interpolate(lockup, [0, 0.3], [0, 1], { extrapolateRight: 'clamp' }),
          zIndex: 5,
        }}
      >
        <span
          style={{
            fontFamily: font.display,
            fontSize: 104,
            lineHeight: 1,
            letterSpacing: '-0.012em',
            color: color.white,
            paddingRight: '0.06em',
            textShadow: '0 12px 44px rgba(0,0,0,0.8)',
          }}
        >
          NAVIX
        </span>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            fontFamily: font.text,
            fontWeight: 600,
            fontSize: 27,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: color.muted,
          }}
        >
          <span>ЛЦТ core</span>
          <span style={{ color: color.bee, opacity: 0.85 }}>|</span>
          <span>МИСИС</span>
        </div>
      </div>
    </AbsoluteFill>
  );
}
