import { describe, expect, it } from 'vitest';
import { ENGINEER_ARTBOARD, ENGINEER_PHONE_MAX, engineerFrameScale, eu } from './engineerScale';

describe('engineerFrameScale', () => {
  it('fills a phone width without using Figma pixels 1:1', () => {
    expect(engineerFrameScale(390)).toBeCloseTo(390 / ENGINEER_ARTBOARD.width);
    expect(engineerFrameScale(390)).toBeLessThan(1);
    expect(engineerFrameScale(390) * 40).toBeCloseTo(23.28, 1);
  });

  it('caps the desktop column at the phone max', () => {
    expect(engineerFrameScale(1920)).toBeCloseTo(ENGINEER_PHONE_MAX / ENGINEER_ARTBOARD.width);
  });

  it('never returns zero for a degenerate width', () => {
    expect(engineerFrameScale(0)).toBeCloseTo(1 / ENGINEER_ARTBOARD.width);
  });
});

describe('eu', () => {
  it('multiplies a Figma token by --eu so the unit stays one CSS pixel', () => {
    expect(eu(40)).toBe('calc(40 * var(--eu))');
    expect(eu(40)).not.toContain('40px');
  });
});
