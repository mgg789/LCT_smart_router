import { SysError } from '../common/errors';

/**
 * Optimistic concurrency, the mechanism behind the rule that there is no silent overwrite
 * (context/36 section 8).
 *
 * The scenario this defends against is ordinary, not exotic: a client opens the screen for
 * a request, the dispatcher changes its window, and the client then confirms the screen
 * they were looking at. The server must report that the conditions changed and ask for a
 * fresh confirmation, not quietly apply the stale one.
 *
 * Only data the operation is actually based on is checked. Checking everything -- a GPS
 * point, a chat message -- would make ordinary activity block unrelated actions
 * (context/36 section 8).
 */

/**
 * Compares a version the actor saw with the stored one.
 *
 * An absent expectation is allowed: some actions do not follow from a prior read, and
 * `context/36` section 12 marks the field as required only "when needed". Passing it is
 * the caller's decision, and it is checked as soon as it is present.
 */
export function assertExpectedVersion(
  label: string,
  expected: number | null | undefined,
  current: number,
): void {
  if (expected === null || expected === undefined) {
    return;
  }
  if (expected !== current) {
    throw SysError.versionConflict(label, expected, current);
  }
}

/**
 * Confirms that a conditional write actually landed.
 *
 * The write itself carries `where: { id, version: expected }`, so a concurrent change
 * makes it match nothing. A count of zero therefore means someone else got there between
 * the read and the write, and the correct answer is a conflict rather than a retry with
 * the check removed.
 */
export function assertWriteApplied(
  label: string,
  count: number,
  expected: number | null | undefined,
  current: number,
): void {
  if (count === 0) {
    throw SysError.versionConflict(label, expected ?? current, current);
  }
}
