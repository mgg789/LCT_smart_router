import { describe, expect, it } from 'vitest';
import { measureLetterbox, readArtboardScale } from './artboardScale';

describe('readArtboardScale', () => {
  it('keeps a 1440×1000 window width-bound so the 1800px avatar can scale on-screen', () => {
    expect(readArtboardScale({ width: 1440, height: 1000 })).toBe(0.75);
  });

  it('is 1 on the Figma artboard', () => {
    expect(readArtboardScale({ width: 1920, height: 1080 })).toBe(1);
  });
});

describe('measureLetterbox', () => {
  it('covers leftover height as top and bottom strips', () => {
    expect(measureLetterbox(1, { width: 1920, height: 1100 })).toEqual({ x: 4, y: 14 });
  });

  it('covers leftover width as left and right strips', () => {
    expect(measureLetterbox(1, { width: 2000, height: 1080 })).toEqual({ x: 44, y: 4 });
  });
});
