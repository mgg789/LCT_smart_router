import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accumulateSwipeCollapse,
  clampProgress,
  DEMO_TOASTS,
  dismissToast,
  getToasts,
  invertToastSwipe,
  pushToast,
  resetToastsForTests,
  seedDemoToasts,
  setToastColumnPinned,
  sortToasts,
  TOAST_CARD_HEIGHT,
  TOAST_GAP,
  TOAST_PEEK_MS,
  TOAST_STACK_BOTTOM,
  TOAST_STACK_TOP,
  toastFromAlert,
  updateToast,
  upsertNewToasts,
  visibleToastLimit,
  visibleToastsForColumn,
} from './toasts';

afterEach(() => {
  vi.useRealTimers();
  resetToastsForTests();
});

describe('toast stack', () => {
  it('keeps alerts first and newer cards ahead of older ones', () => {
    const sorted = sortToasts([
      { id: 'r', kind: 'route', title: 'route', body: '', createdAt: 1 },
      { id: 'a2', kind: 'alert', title: 'alert 2', body: '', createdAt: 30 },
      { id: 's', kind: 'system', title: 'sys', body: '', createdAt: 2 },
      { id: 'a1', kind: 'alert', title: 'alert 1', body: '', createdAt: 10 },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['a2', 'a1', 's', 'r']);
  });

  it('peeks only a new card after the column was collapsed', () => {
    vi.useFakeTimers();
    pushToast({ id: 'old-1', kind: 'system', title: 'a', createdAt: 1 });
    pushToast({ id: 'old-2', kind: 'system', title: 'b', createdAt: 2 });
    setToastColumnPinned(false);
    expect(visibleToastsForColumn()).toEqual([]);
    pushToast({ id: 'fresh', kind: 'system', title: 'c', createdAt: 3 });
    expect(visibleToastsForColumn().map((item) => item.id)).toEqual(['fresh']);
    expect(getToasts().map((item) => item.id)).toEqual(['fresh', 'old-2', 'old-1']);
    vi.advanceTimersByTime(TOAST_PEEK_MS);
    expect(visibleToastsForColumn()).toEqual([]);
    expect(getToasts()).toHaveLength(3);
    setToastColumnPinned(true);
    expect(visibleToastsForColumn().map((item) => item.id)).toEqual(['fresh', 'old-2', 'old-1']);
    vi.useRealTimers();
  });

  it('shows simultaneous arrivals one at a time without pinning the column', () => {
    vi.useFakeTimers();
    upsertNewToasts([
      { id: 'first', kind: 'system', title: 'one', createdAt: 1 },
      { id: 'second', kind: 'alert', title: 'two', createdAt: 2 },
    ]);
    expect(visibleToastsForColumn()).toHaveLength(1);
    expect(visibleToastsForColumn()[0]?.id).toBe('second');
    vi.advanceTimersByTime(TOAST_PEEK_MS);
    expect(visibleToastsForColumn()).toEqual([]);
  });

  it('hydrates the inbox silently', () => {
    upsertNewToasts([{ id: 'existing', kind: 'alert', title: 'old', createdAt: 1 }], false);
    expect(getToasts()).toHaveLength(1);
    expect(visibleToastsForColumn()).toEqual([]);
  });

  it('keeps progress visible until the operation completes', () => {
    vi.useFakeTimers();
    setToastColumnPinned(false);
    pushToast({ id: 'p', kind: 'progress', title: 'Пересчет', progress: 20, etaLabel: '2 мин' });
    vi.advanceTimersByTime(TOAST_PEEK_MS);
    expect(visibleToastsForColumn().map((item) => item.id)).toEqual(['p']);
    expect(getToasts().map((item) => item.id)).toEqual(['p']);
    expect(updateToast('p', { progress: 100 })).toBeNull();
    expect(visibleToastsForColumn()).toEqual([]);
    expect(getToasts()).toEqual([]);
    vi.useRealTimers();
  });

  it('clamps progress and dismisses a card that reaches 100', () => {
    expect(clampProgress(-4)).toBe(0);
    expect(clampProgress(140)).toBe(100);
    expect(
      pushToast({ id: 'p', kind: 'progress', title: 'Пересчет', progress: 20, etaLabel: '3 мин' })
        ?.progress,
    ).toBe(20);
    expect(updateToast('p', { progress: 55, etaLabel: '1 мин' })).toMatchObject({
      progress: 55,
      etaLabel: '1 мин',
    });
    expect(updateToast('p', { progress: 100 })).toBeNull();
    expect(getToasts()).toEqual([]);
  });

  it('does not revive a dismissed id on upsert, and seeds the six Figma kinds', () => {
    seedDemoToasts();
    expect(getToasts()[0]?.kind).toBe('alert');
    expect(getToasts().length).toBeGreaterThan(visibleToastLimit());
    expect(new Set(DEMO_TOASTS.map((item) => item.kind)).size).toBe(6);
    dismissToast('demo-alert');
    upsertNewToasts(DEMO_TOASTS);
    expect(getToasts().some((item) => item.id === 'demo-alert')).toBe(false);
  });

  it('fits the stack under the content bottom after the column starts higher', () => {
    const limit = visibleToastLimit();
    expect(limit).toBe(6);
    expect(TOAST_STACK_TOP).toBeLessThan(80);
    expect(
      TOAST_STACK_TOP + limit * TOAST_CARD_HEIGHT + (limit - 1) * TOAST_GAP,
    ).toBeLessThanOrEqual(TOAST_STACK_BOTTOM);
  });

  it('maps an open alert onto a yellow toast', () => {
    const toast = toastFromAlert({
      id: 'al-1',
      code: 'NO_SKILL_MATCH',
      severity: 'warning',
      engineerIds: [],
      requestIds: [],
      reasons: ['Нет инженера с нужным навыком'],
      restoreOption: null,
      createdAt: 9,
      seenAt: null,
      resolvedAt: null,
    });
    expect(toast.kind).toBe('alert');
    expect(toast.id).toBe('alert:al-1');
    expect(toast.title).toContain('Алёрт');
    expect(toast.body).toContain('навыком');
    const notice = toastFromAlert({
      id: 'notice',
      code: 'plan_rebuilt',
      kind: 'notice',
      severity: 'info',
      engineerIds: [],
      requestIds: [],
      reasons: [],
      restoreOption: null,
      createdAt: 10,
      seenAt: null,
      resolvedAt: null,
    });
    expect(notice.kind).toBe('route');
    expect(notice.title).toBe('План перестроился');
  });

  it('collapses the column on a rightward two-finger wheel swipe', () => {
    expect(accumulateSwipeCollapse(20, 4, 0)).toEqual({ accumulated: 20, collapse: false });
    expect(accumulateSwipeCollapse(70, 8, 20)).toEqual({ accumulated: 0, collapse: true });
    expect(accumulateSwipeCollapse(12, 40, 30)).toEqual({ accumulated: 0, collapse: false });
    expect(accumulateSwipeCollapse(-30, 0, 40)).toEqual({ accumulated: 0, collapse: false });
  });

  it('inverts the collapse direction on macOS trackpads', () => {
    expect(invertToastSwipe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel')).toBe(
      true,
    );
    expect(invertToastSwipe('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32')).toBe(false);
    expect(accumulateSwipeCollapse(-70, 4, 20, 80, true)).toEqual({
      accumulated: 0,
      collapse: true,
    });
    expect(accumulateSwipeCollapse(70, 4, 20, 80, true)).toEqual({
      accumulated: 0,
      collapse: false,
    });
  });
});
