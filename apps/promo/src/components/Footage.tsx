/**
 * A shot: one stretch of a real take, framed by a camera, with the cursor drawn back on.
 *
 * `from` is either seconds into the take or the name of a mark the scene script set, so
 * the edit stays attached to what happened on screen rather than to a stopwatch.
 */
import type { ReactNode } from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { cursorAt, hasShot, mark, shot } from '../footage.ts';
import { color, HEIGHT, WIDTH } from '../theme.ts';
import { type CameraKey, cameraAt, cameraTransform, STILL } from './Camera.tsx';
import { Cursor } from './Cursor.tsx';

export interface FootageProps {
  readonly scene: string;
  /** Seconds into the take, or the name of a mark on it. */
  readonly from?: number | string;
  /** Nudge, in seconds, applied after a named mark is resolved. */
  readonly offset?: number;
  readonly camera?: readonly CameraKey[];
  readonly cursor?: boolean;
  /** Speed of playback; 1 is real time. */
  readonly rate?: number;
  readonly children?: ReactNode;
}

function startSeconds(scene: string, from: number | string | undefined, offset: number): number {
  const base = typeof from === 'string' ? mark(scene, from) : (from ?? 0);
  return Math.max(0, base + offset);
}

/** A take that fills the frame: the dispatcher dashboard, filmed 16:9. */
export function Footage({
  scene,
  from,
  offset = 0,
  camera = STILL,
  cursor = true,
  rate = 1,
  children,
}: FootageProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entry = shot(scene);
  const start = startSeconds(scene, from, offset);
  const local = (frame / fps) * rate;
  const sourceTime = Math.min(entry.duration - 1 / fps, start + local);
  const cam = cameraAt(camera, frame / fps);
  const pointer = cursorAt(scene, sourceTime);

  // The take is laid out at the size it was filmed and the camera carries the fit, so a
  // push samples the original pixels instead of magnifying an already-shrunk frame. The
  // extra couple of percent is overscan: a speed blur softens the edges of what it is
  // applied to, and without it that softness reaches into the frame as a dark rim.
  const fit = (WIDTH / entry.width) * 1.03;

  return (
    <AbsoluteFill style={{ backgroundColor: color.stage, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          width: entry.width,
          height: entry.height,
          ...cameraTransform(
            { ...cam, scale: cam.scale * fit },
            { width: entry.width, height: entry.height },
            { width: WIDTH, height: HEIGHT },
          ),
        }}
      >
        <OffthreadVideo
          src={staticFile(entry.file)}
          trimBefore={Math.round(start * fps)}
          playbackRate={rate}
          muted
          style={{
            width: entry.width,
            height: entry.height,
            objectFit: 'cover',
            display: 'block',
          }}
        />
        {cursor && pointer.visible ? (
          <Cursor
            x={pointer.x * entry.width}
            y={pointer.y * entry.height}
            press={pointer.press}
            sincePress={pointer.sincePress}
            scale={1 / Math.max(1, cam.scale * 0.72) / fit}
          />
        ) : null}
      </div>
      {children}
    </AbsoluteFill>
  );
}

export interface PhoneFootageProps extends FootageProps {
  /** Height of the phone on the 1080-tall stage. */
  readonly height?: number;
  readonly x?: number;
  readonly y?: number;
  readonly tilt?: number;
  readonly glow?: boolean;
  /**
   * A take to hold behind the phone, blurred and dimmed almost to a texture.
   * The two surfaces are one day seen from two places, and a dead black stage loses that.
   */
  readonly backdrop?: string;
}

/**
 * A phone take, inside a device the reel draws around it.
 *
 * The screen keeps the take's own aspect, so nothing inside the app is stretched; the
 * bezel, corner radius and shadow are the only things added.
 */
export function PhoneFootage({
  scene,
  from,
  offset = 0,
  camera = STILL,
  cursor = true,
  rate = 1,
  height = 940,
  x = WIDTH / 2,
  y = HEIGHT / 2,
  tilt = 0,
  glow = true,
  backdrop,
  children,
}: PhoneFootageProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entry = shot(scene);
  const start = startSeconds(scene, from, offset);
  const local = (frame / fps) * rate;
  const sourceTime = Math.min(entry.duration - 1 / fps, start + local);
  const cam = cameraAt(camera, frame / fps);
  const pointer = cursorAt(scene, sourceTime);

  const screenWidth = (height * entry.width) / entry.height;
  const bezel = Math.max(6, height * 0.012);
  const radius = height * 0.062;

  // The camera aims at the screen's own coordinates, so a push can find the code field
  // or the send button without knowing where the phone sits on the stage.
  const focusX = (cam.cx - 0.5) * screenWidth * cam.scale;
  const focusY = (cam.cy - 0.5) * height * cam.scale;

  const behind = backdrop && hasShot(backdrop) ? shot(backdrop) : null;

  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: color.stage }}>
      {behind ? (
        <AbsoluteFill style={{ opacity: 0.3 }}>
          <OffthreadVideo
            src={staticFile(behind.file)}
            trimBefore={Math.round(Math.max(0, behind.duration - 8) * fps)}
            muted
            style={{
              width: WIDTH * 1.22,
              height: HEIGHT * 1.22,
              marginLeft: WIDTH * -0.11,
              marginTop: HEIGHT * -0.11,
              objectFit: 'cover',
              filter: 'blur(34px) saturate(0.7) brightness(0.52)',
            }}
          />
          <AbsoluteFill
            style={{
              background:
                'radial-gradient(52% 46% at 50% 50%, rgba(8,9,11,0.88) 0%, rgba(8,9,11,0.52) 100%)',
            }}
          />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill
        style={{
          transform: `translate3d(${x - WIDTH / 2 - focusX}px, ${y - HEIGHT / 2 - focusY}px, 0)`,
          willChange: 'transform',
        }}
      >
        <AbsoluteFill
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: screenWidth + bezel * 2,
              height: height + bezel * 2,
              borderRadius: radius + bezel,
              padding: bezel,
              background: 'linear-gradient(160deg, #3a3d45 0%, #14161a 38%, #24272e 100%)',
              boxShadow: glow
                ? `0 ${height * 0.05}px ${height * 0.13}px rgba(0,0,0,0.62), 0 0 0 1px rgba(255,255,255,0.08), 0 0 ${height * 0.2}px rgba(255,199,44,0.09)`
                : `0 ${height * 0.04}px ${height * 0.1}px rgba(0,0,0,0.55)`,
              transform: `rotate(${tilt}deg) scale(${cam.scale})`,
              transformOrigin: 'center center',
              willChange: 'transform',
            }}
          >
            <div
              style={{
                position: 'relative',
                width: screenWidth,
                height,
                borderRadius: radius,
                overflow: 'hidden',
                background: color.canvas,
              }}
            >
              {/* Native size, scaled down into the screen: the same pixels the app drew. */}
              <div
                style={{
                  position: 'absolute',
                  width: entry.width,
                  height: entry.height,
                  transformOrigin: '0 0',
                  transform: `scale(${(height / entry.height).toFixed(5)})`,
                }}
              >
                <OffthreadVideo
                  src={staticFile(entry.file)}
                  trimBefore={Math.round(start * fps)}
                  playbackRate={rate}
                  muted
                  style={{
                    width: entry.width,
                    height: entry.height,
                    objectFit: 'cover',
                    display: 'block',
                  }}
                />
                {cursor && pointer.visible ? (
                  <Cursor
                    x={pointer.x * entry.width}
                    y={pointer.y * entry.height}
                    press={pointer.press}
                    sincePress={pointer.sincePress}
                    scale={(0.82 * entry.height) / height}
                  />
                ) : null}
              </div>
            </div>
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
      {children}
    </AbsoluteFill>
  );
}
