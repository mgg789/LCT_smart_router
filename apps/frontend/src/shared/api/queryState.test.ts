import { describe, expect, it } from 'vitest';
import { failedWithoutData } from './queryState';

describe('failedWithoutData', () => {
  it('keeps a screen up when only a refetch failed', () => {
    expect(failedWithoutData({ isError: true, data: { plan: null } })).toBe(false);
  });

  it('fails a screen that never got an answer', () => {
    expect(failedWithoutData({ isError: true, data: undefined })).toBe(true);
  });

  it('does not fail a healthy query', () => {
    expect(failedWithoutData({ isError: false, data: undefined })).toBe(false);
  });
});
