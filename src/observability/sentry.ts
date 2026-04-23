/**
 * Conditional Sentry loader.
 *
 * When `SENTRY_DSN` is unset (the default), this module never imports
 * `@sentry/node` at all — the dynamic import in `initSentry()` is guarded.
 * Call sites always go through the `SentryLike` surface, which stubs to no-ops
 * when Sentry isn't active.
 */

export interface SentryLike {
  captureException(
    err: unknown,
    hint?: { extra?: Record<string, unknown> },
  ): void;
  close(timeoutMs?: number): Promise<boolean>;
}

const NOOP_SENTRY: SentryLike = {
  captureException: () => {
    /* no-op */
  },
  close: async () => true,
};

let active: SentryLike = NOOP_SENTRY;

/**
 * Initialize Sentry if SENTRY_DSN is set. Safe to call multiple times (later
 * calls are no-ops). Returns the active SentryLike instance for convenience.
 */
export async function initSentry(): Promise<SentryLike> {
  if (active !== NOOP_SENTRY) return active;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return active; // stay on noop

  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    release: process.env.RELEASE,
    tracesSampleRate: 0,
  });

  active = {
    captureException: (err, hint) => Sentry.captureException(err, hint),
    close: (timeoutMs = 2000) => Sentry.close(timeoutMs),
  };
  return active;
}

/** Returns the current SentryLike (noop until initSentry() runs with a DSN). */
export function getSentry(): SentryLike {
  return active;
}
