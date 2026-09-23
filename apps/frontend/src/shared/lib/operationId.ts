/**
 * Fresh id for one user intention. Every write carries it, and a retry repeats the
 * same id so the API returns the first outcome instead of doing the work twice
 * (docs/frontend-api.md §4).
 */
export function newOperationId(): string {
  return crypto.randomUUID();
}
