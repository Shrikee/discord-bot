/**
 * Per-user "one `/ask` in flight" lock.
 *
 * A Set is sufficient because we don't need to await the in-flight request —
 * we only need to know whether one exists.
 */

const inFlight = new Set<string>();

/**
 * Attempt to claim the lock for `userId`. Returns `true` if claimed (caller
 * MUST eventually call `release`), `false` if the user already holds it.
 */
export function tryAcquire(userId: string): boolean {
  if (inFlight.has(userId)) return false;
  inFlight.add(userId);
  return true;
}

/** Release the lock for `userId`. Idempotent. */
export function release(userId: string): void {
  inFlight.delete(userId);
}

/** Current number of in-flight `/ask` requests (for debug/metrics). */
export function inFlightCount(): number {
  return inFlight.size;
}
