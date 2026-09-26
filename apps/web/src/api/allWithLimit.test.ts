import { describe, expect, it } from 'vitest';
import { allWithLimit } from './client';

describe('allWithLimit', () => {
  it('keeps at most two calls running', async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, () => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return peak;
    });
    const peaks = await allWithLimit(2, tasks);
    expect(Math.max(...peaks)).toBe(2);
    expect(peaks).toHaveLength(6);
  });
});
