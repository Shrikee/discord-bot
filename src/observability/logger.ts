import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger } from "pino";
import { getSentry } from "./sentry.js";

export interface RequestContext {
  interactionId?: string;
  userId?: string;
  userTag?: string;
  guildId?: string;
  channelId?: string;
  commandName?: string;
}

const als = new AsyncLocalStorage<{ logger: Logger }>();

const isProd = process.env.NODE_ENV === "production";

/**
 * Root logger — JSON in prod, pretty-printed in dev. Errors flow to Sentry
 * automatically via the `logMethod` hook when a payload includes `err`.
 */
const root: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined, // drop pid/hostname noise; we have Docker for that
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss.l" },
        },
      }),
  hooks: {
    logMethod(args, method, level) {
      // Call the real log method first…
      method.apply(this, args as Parameters<typeof method>);
      // …then forward errors to Sentry if the payload carries one.
      if (level >= 50 /* error */) {
        const first = args[0];
        if (first && typeof first === "object" && "err" in first) {
          const { err, ...extra } = first as Record<string, unknown>;
          getSentry().captureException(err, { extra });
        }
      }
    },
  },
});

/**
 * Runs `fn` with a request-scoped child logger bound to `ctx`. Any call to
 * `log()` (or `log.error`, etc.) inside `fn` — including through async/await
 * and `for await` — will resolve to the child logger.
 */
export function withRequestContext<T>(
  ctx: RequestContext,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return als.run({ logger: root.child(ctx) }, fn);
}

/**
 * The resolved logger for the current async context — falls back to the root
 * logger outside any `withRequestContext` scope (e.g. startup/shutdown).
 */
export const log: Logger = new Proxy(root, {
  get(_target, prop, receiver) {
    const current = als.getStore()?.logger ?? root;
    const value = Reflect.get(current, prop, receiver);
    return typeof value === "function" ? value.bind(current) : value;
  },
}) as Logger;

/** Escape hatch for tests that want a concrete child without entering ALS. */
export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return root.child(bindings);
}

/** Flush pino's async queue (if any). Safe to call at shutdown. */
export function flushLogs(): Promise<void> {
  return new Promise((resolve) => {
    root.flush(() => resolve());
  });
}
