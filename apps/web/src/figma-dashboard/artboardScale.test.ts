import { describe, expect, it } from 'vitest';
import { measureLetterbox } from './artboardScale';

describe('measureLetterbox', () => {
  it('covers leftover height as top and bottom strips', () => {
    expect(measureLetterbox(1, { width: 1920, height: 1100 })).toEqual({ x: 4, y: 14 });
  });

  it('covers leftover width as left and right strips', () => {
    expect(measureLetterbox(1, { width: 2000, height: 1080 })).toEqual({ x: 44, y: 4 });
  });
});
