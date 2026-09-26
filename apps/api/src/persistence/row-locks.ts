import type { Tx } from './unit-of-work';

/**
 * Pessimistic locks on the rows that arbitrate the working plan and a LIVE day.
 *
 * Prisma has no `SELECT ... FOR UPDATE`, so these places drop to raw SQL. They are
 * kept here, together and named, rather than spread through the services: the whole
 * point is that this is a short, reviewable list of everything that takes a row lock.
 *
 * Global lock order (take a prefix, never invert):
 *   1. every `live_workdays` row that the transaction will touch
 *   2. `control_state` singleton
 *   3. `routing_current` singleton
 *   4. alert advisory lock
 *
 * LIVE advance takes 1 then 3. Router acceptance takes 2 then 3. A reset must take
 * 1 then 2 then 3 before deleting, otherwise it deadlocks with an in-flight advance
 * (workday held, waiting for routing / routing held, waiting for workday).
 *
 * Why a lock is needed at all: accepting a Router result and switching to manual mode
 * race with each other. Without serialising them, a result that was already in flight
 * could be written after the dispatcher took control, overwriting the manual plan --
 * the exact failure context/36 section 13 requires us not to have.
 */

/** Locks the AUTO/MANUAL row until the surrounding transaction ends. */
export async function lockControlState(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT id FROM control_state WHERE id = 'singleton' FOR UPDATE`;
}

/** Locks the published-snapshot pointer until the surrounding transaction ends. */
export async function lockRoutingCurrent(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT id FROM routing_current WHERE id = 'singleton' FOR UPDATE`;
}

/**
 * Locks every LIVE day the transaction will delete or advance.
 * Must run before `lockControlState` / `lockRoutingCurrent`.
 */
export async function lockLiveWorkdays(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT id FROM live_workdays FOR UPDATE`;
}

/** Serialises alert detection, resolution and day closure for the transaction lifetime. */
export async function lockAlertQueue(tx: Tx): Promise<void> {
  // Keep the same lock order as Router result acceptance. Alert actions may publish a
  // snapshot, while acceptance stores Router alerts; advisory-only locking here would
  // form an AB/BA cycle with control_state -> routing_current -> alert queue.
  await lockControlState(tx);
  await lockRoutingCurrent(tx);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(731024)`;
}
