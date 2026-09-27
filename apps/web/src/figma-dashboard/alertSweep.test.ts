import { expect, it } from 'vitest';
import { runAlertSweep } from './alertSweep';

it('captures the initial queue and continues after a declined decision', async () => {
  const items = ['first', 'second'];
  const visited: string[] = [];
  await runAlertSweep(
    items,
    async (item) => {
      visited.push(item);
      items.splice(0, items.length, 'incoming');
      return item !== 'first';
    },
    () => false,
  );
  expect(visited).toEqual(['first', 'second']);
});

it('waits for each decision and stops after the view is unmounted', async () => {
  let cancelled = false;
  let finish: (() => void) | undefined;
  const visited: number[] = [];
  const pending = runAlertSweep(
    [1, 2],
    async (item) => {
      visited.push(item);
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return true;
    },
    () => cancelled,
  );
  expect(visited).toEqual([1]);
  cancelled = true;
  finish?.();
  await pending;
  expect(visited).toEqual([1]);
});
