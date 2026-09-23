import { afterEach, describe, expect, it } from 'vitest';
import { notify, TOAST_DURATION_MS, TOAST_LIMIT, useToastStore } from './toasts';

afterEach(() => useToastStore.getState().clear());

describe('toast store', () => {
  it('puts the newest on top with the default lifetime', () => {
    notify({ id: 'a', kind: 'system', title: 'A' });
    notify({ id: 'b', kind: 'system', title: 'B' });

    const { toasts } = useToastStore.getState();
    expect(toasts.map((toast) => toast.id)).toEqual(['b', 'a']);
    expect(toasts[0]?.durationMs).toBe(TOAST_DURATION_MS);
  });

  it('replaces a notice with the same id instead of stacking a second', () => {
    notify({ id: 'recalc', kind: 'progress', title: 'Пересчёт', durationMs: null });
    notify({ id: 'recalc', kind: 'done', title: 'Готово' });

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: 'done', durationMs: TOAST_DURATION_MS });
  });

  it('lets the oldest go when there are too many', () => {
    for (let i = 0; i < TOAST_LIMIT + 2; i += 1)
      notify({ id: `t${i}`, kind: 'system', title: `${i}` });

    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(TOAST_LIMIT);
    expect(toasts.at(-1)?.id).toBe('t2');
  });

  it('dismisses by id', () => {
    notify({ id: 'a', kind: 'system', title: 'A' });
    useToastStore.getState().dismiss('a');
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
