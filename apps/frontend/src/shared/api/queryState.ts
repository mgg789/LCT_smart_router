/**
 * Whether a polled query has failed with nothing to show.
 *
 * A failed *refetch* keeps the last good answer, and that is what the screen
 * should keep showing: the System Layer can miss one poll — for instance while
 * the Router is busy with a policy comparison — without the day being lost.
 * Only a query that never got an answer is a screen-level failure.
 */
export function failedWithoutData(query: { isError: boolean; data: unknown }): boolean {
  return query.isError && query.data === undefined;
}
