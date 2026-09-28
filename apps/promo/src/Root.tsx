import { Composition } from 'remotion';
import { REEL_FRAMES, Reel } from './Reel.tsx';
import { FPS, HEIGHT, WIDTH } from './theme.ts';

export function Root() {
  return (
    <Composition
      id="Reel"
      component={Reel}
      durationInFrames={REEL_FRAMES}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  );
}
