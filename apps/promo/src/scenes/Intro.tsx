/**
 * The opening.
 *
 * The mark is wiped in along the angle of its own stripes, NAVIX rises under it, and the
 * two settle into exactly the positions they occupy on the product's real start screen —
 * so the cut into the footage that follows lands on the same lockup and reads as one
 * continuous shot rather than a title card followed by a screen.
 *
 * "Exactly" means the first frame of the next shot, not the raw capture: that shot runs
 * a camera over the take, and the camera is what decides where the lockup actually sits
 * on the stage. `LOCKUP` below is that framed position, measured through the same maths
 * `Camera.tsx` uses, which is why the mark is larger and lower here than on the capture.
 */
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { ease, Rise } from '../components/Type.tsx';
import { color, EASE_SNAP, font, HEIGHT, WIDTH } from '../theme.ts';

/** Where the next shot's first frame puts the lockup, in stage fractions. */
export const LOCKUP = {
  markCentreY: 0.297 * HEIGHT,
  markSize: 0.364 * HEIGHT,
  wordCentreY: 0.614 * HEIGHT,
  wordCap: 0.1365 * HEIGHT,
  /** The row of day pills on the real screen — the strapline hands over to them. */
  straplineY: 0.755 * HEIGHT,
} as const;

export function Intro() {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  // A thin line of the brand yellow opens the frame before anything else exists.
  const seamP = ease(Math.min(1, frame / 22), EASE_SNAP);
  const seamWidth = interpolate(seamP, [0, 1], [0, WIDTH * 0.46]);
  const seamFade = interpolate(frame, [16, 34], [1, 0], { extrapolateRight: 'clamp' });

  // The mark arrives as its own stripes sweep across it.
  const markP = ease(Math.min(1, Math.max(0, (frame - 14) / 42)));
  const wipe = interpolate(markP, [0, 1], [-140, 240]);
  const markScale = interpolate(markP, [0, 1], [1.18, 1]);
  const markLift = interpolate(markP, [0, 1], [HEIGHT * 0.045, 0]);

  const glow = interpolate(frame, [30, 58, 96], [0, 0.6, 0.26], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ backgroundColor: color.stage, overflow: 'hidden' }}>
      {/* The light behind the mark is a tall column rather than a disc: it has to reach
          the strapline, because the screen this hands over to is lit the same way. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(64% 86% at 50% 40%, rgba(255,199,44,${glow.toFixed(3)}) 0%, rgba(255,199,44,${(glow * 0.34).toFixed(3)}) 34%, rgba(255,199,44,0) 76%)`,
        }}
      />

      {seamFade > 0.01 ? (
        <div
          style={{
            position: 'absolute',
            left: WIDTH / 2 - seamWidth / 2,
            top: LOCKUP.markCentreY,
            width: seamWidth,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${color.bee}, transparent)`,
            opacity: seamFade,
            filter: 'blur(0.4px)',
          }}
        />
      ) : null}

      <div
        style={{
          position: 'absolute',
          left: WIDTH / 2 - LOCKUP.markSize / 2,
          top: LOCKUP.markCentreY - LOCKUP.markSize / 2 + markLift,
          width: LOCKUP.markSize,
          height: LOCKUP.markSize,
          transform: `scale(${markScale})`,
          transformOrigin: 'center center',
          // The stripes of the mark run at 45 degrees, so the reveal runs with them.
          maskImage: `linear-gradient(135deg, #000 ${wipe - 60}%, #000 ${wipe}%, transparent ${wipe + 26}%)`,
          WebkitMaskImage: `linear-gradient(135deg, #000 ${wipe - 60}%, #000 ${wipe}%, transparent ${wipe + 26}%)`,
        }}
      >
        {/* The file on disk is the dark mark; the start screen shows it white, so it is
            flattened to white here rather than shipping a second copy of the asset. */}
        <Img
          src={staticFile('brand/logo-dark.png')}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            filter: `brightness(0) invert(1) drop-shadow(0 ${HEIGHT * 0.018}px ${HEIGHT * 0.05}px rgba(0,0,0,0.55))`,
          }}
        />
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: LOCKUP.wordCentreY - LOCKUP.wordCap * 0.78,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <Rise delay={40} duration={30} distance={1}>
          <span
            style={{
              display: 'block',
              fontFamily: font.display,
              fontSize: LOCKUP.wordCap * 1.42,
              lineHeight: 1,
              color: color.white,
              letterSpacing: interpolate(
                ease(Math.min(1, Math.max(0, (frame - 40) / 40))),
                [0, 1],
                [0.1, -0.012],
              ),
              paddingRight: '0.06em',
            }}
          >
            NAVIX
          </span>
        </Rise>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: LOCKUP.straplineY,
          display: 'flex',
          justifyContent: 'center',
          // Out again before the cut, so the pills of the real screen arrive to a clear row.
          opacity: interpolate(frame, [durationInFrames - 22, durationInFrames - 6], [1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        <Rise delay={72} duration={24}>
          <span
            style={{
              fontFamily: font.text,
              fontWeight: 600,
              fontSize: HEIGHT * 0.023,
              letterSpacing: '0.36em',
              textTransform: 'uppercase',
              color: color.muted,
            }}
          >
            Маршруты выездных инженеров
          </span>
        </Rise>
      </div>
    </AbsoluteFill>
  );
}
