import { createContext, useContext } from 'react';
import type { ArtboardCanvas } from './artboardScale';
import { FIGMA_ARTBOARD } from './fixtures';

/**
 * How much room the window gives the board beyond the drawing, in artboard
 * units. Both are 0 on a 16:9 screen, which is the size everything was drawn
 * against.
 */
export interface ArtboardStretch {
  dx: number;
  dy: number;
}

const NO_STRETCH: ArtboardStretch = { dx: 0, dy: 0 };

const StretchContext = createContext<ArtboardStretch>(NO_STRETCH);

export const ArtboardStretchProvider = StretchContext.Provider;

/**
 * The spare width and height of the current canvas.
 *
 * Context rather than props because the pieces that have to answer to it — the
 * header's right-hand controls, the map, the two side panels — sit at very
 * different depths of one 16:9 drawing, and threading two numbers through every
 * layer between them would be noise. Outside a provider it reports no stretch,
 * so a component rendered on its own in a test still lays out as drawn.
 */
export function useArtboardStretch(): ArtboardStretch {
  return useContext(StretchContext);
}

/** Spare room of a measured canvas, never negative. */
export function stretchOf(canvas: ArtboardCanvas): ArtboardStretch {
  return {
    dx: Math.max(0, canvas.width - FIGMA_ARTBOARD.width),
    dy: Math.max(0, canvas.height - FIGMA_ARTBOARD.height),
  };
}
