import { afterEach, describe, expect, it } from 'vitest';
import {
  DEMO_TOASTS,
  TOAST_CARD_HEIGHT,
  TOAST_GAP,
  TOAST_STACK_BOTTOM,
  TOAST_STACK_TOP,
  clampProgress,
  dismissToast,
  getToasts,
  pushToast,
  resetToastsForTests,
  seedDemoToasts,
  sortToasts,
  toastFromAlert,
  updateToast,
  upsertNewToasts,
  visibleToastLimit,
} from './toasts';

afterEach(() => {
  resetToastsForTests();
});

describe('toast stack', () => {
  it('keeps alerts first and everyone else in arrival order', () => {
    const sorted = sortToasts([
      { id: 'r', kind: 'route', title: 'route', body: '', createdAt: 1 },
      { id: 'a2', kind: 'alert', title: 'alert 2', body: '', createdAt: 30 },
      { id: 's', kind: 'system', title: 'sys', body: '', createdAt: 2 },
      { id: 'a1', kind: 'alert', title: 'alert 1', body: '', createdAt: 10 },
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['a1', 'a2', 'r', 's']);
  });

  it('clamps progress and dismisses a card that reaches 100', () => {
    expect(clampProgress(-4)).toBe(0);
    expect(clampProgress(140)).toBe(100);
    expect(pushToast({ id: 'p', kind: 'progress', title: 'Пересчет', progress: 20, etaLabel: '3 мин' })?.progress).toBe(
      20,
    );
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

  it('fits an exact stack of cards to the main content bottom edge', () => {
    const limit = visibleToastLimit();
    expect(limit).toBe(6);
    expect(TOAST_STACK_TOP + limit * TOAST_CARD_HEIGHT + (limit - 1) * TOAST_GAP).toBe(TOAST_STACK_BOTTOM);
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
  });
});
