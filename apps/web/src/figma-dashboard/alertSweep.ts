/** Runs the captured alert queue once, sequentially; a declined item does not stop the rest. */
export async function runAlertSweep<T>(
  items: readonly T[],
  resolve: (item: T, index: number, cancelled: () => boolean) => Promise<boolean>,
  cancelled: () => boolean,
): Promise<void> {
  const queue = [...items];
  for (const [index, item] of queue.entries()) {
    if (cancelled()) return;
    await resolve(item, index, cancelled);
  }
}
