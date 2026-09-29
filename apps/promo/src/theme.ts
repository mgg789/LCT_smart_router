/**
 * The reel borrows the product's own palette and type, so the motion around a screen
 * never looks like it came from somewhere else.
 *
 * Colours are the tokens in `apps/web/src/index.css`; the display face is the same
 * MursGothic the app sets NAVIX in.
 */
import { staticFile } from 'remotion';

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

export const color = {
  /** Deeper than the app's own canvas: the reel is graded for a dark room. */
  stage: '#08090b',
  stageSoft: '#111318',
  ink: '#272930',
  canvas: '#f1f1f1',
  bee: '#ffc72c',
  beeDeep: '#f5a623',
  white: '#ffffff',
  muted: '#8b8f98',
  done: '#2f9e44',
  danger: '#f72030',
  aiFrom: '#ff9de2',
  aiVia: '#c9a4ff',
  aiTo: '#6ec5ff',
} as const;

export const font = {
  display: 'MursGothic',
  text: 'PromoInter',
  /** Handwriting for the marker layer: notes on the flipchart, never UI copy. */
  hand: 'PromoHand',
} as const;

/** The marker drawn over footage: warm enough to read on the light dashboard. */
export const MARKER = '#ff4a2b';
/** The second marker, so the flipchart is not written in one colour. */
export const MARKER_BLUE = '#2f62e8';

/** Injected once per composition so every text element measures the same. */
export const FONT_FACES = `
@font-face {
  font-family: 'PromoHand';
  src: url('${staticFile('brand/Caveat.ttf')}') format('truetype');
  font-weight: 400 700;
  font-display: block;
}
@font-face {
  font-family: 'MursGothic';
  src: url('${staticFile('brand/mursgothic-widedark.otf')}') format('opentype');
  font-weight: 400 900;
  font-display: block;
}
@font-face {
  font-family: 'PromoInter';
  src: url('${staticFile('brand/Inter-Regular.woff2')}') format('woff2');
  font-weight: 400;
  font-display: block;
}
@font-face {
  font-family: 'PromoInter';
  src: url('${staticFile('brand/Inter-Medium.woff2')}') format('woff2');
  font-weight: 500;
  font-display: block;
}
@font-face {
  font-family: 'PromoInter';
  src: url('${staticFile('brand/Inter-SemiBold.woff2')}') format('woff2');
  font-weight: 600;
  font-display: block;
}
@font-face {
  font-family: 'PromoInter';
  src: url('${staticFile('brand/Inter-Bold.woff2')}') format('woff2');
  font-weight: 700;
  font-display: block;
}
@font-face {
  font-family: 'PromoInter';
  src: url('${staticFile('brand/Inter-ExtraBold.woff2')}') format('woff2');
  font-weight: 800;
  font-display: block;
}
`;

/** The reel's standard ease: quick to leave, long to settle. */
export const EASE = [0.22, 1, 0.36, 1] as const;
/** For cuts that should feel struck rather than played. */
export const EASE_SNAP = [0.16, 1.02, 0.3, 1] as const;
/** For a move that accelerates away, used on whips and hard slides. */
export const EASE_IN = [0.6, 0.02, 0.86, 0.2] as const;
