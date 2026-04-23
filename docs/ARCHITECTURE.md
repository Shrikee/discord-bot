# Architecture

System design, module boundaries, and key decisions for `discord-bot`.

Audience: engineers about to modify the code or operate it in production.
For quick-start and user-facing docs see [`../README.md`](../README.md).

---

## 1. Context and goals

The bot is a **pure HTTP/SSE client** between Discord and
[`dcs-agent`](../../dcs-agent). It has no domain logic of its own, no
database, no queue. Its job is:

1. Receive `/ask <question>` slash-command interactions from Discord.
2. Open an SSE stream to dcs-agent (`POST /api/research/stream`).
3. Render the streamed tokens + tool events back into a single Discord
   reply that updates progressively.
4. Handle the failure modes gracefully (agent down, timeout, oversize
   answer, Discord rate-limits).

**Non-goals.** Conversation memory, prompt engineering, model access, search
tooling — all owned by dcs-agent. If you find yourself adding any of those
here, you're in the wrong repo.

**Constraints that shape the design**
- Discord enforces a ~5-edits/5s per-channel rate limit. Streaming token-
  by-token blows past it immediately — edits must be throttled.
- Discord reply content ≤ 2 000 chars, embed description ≤ 4 096 chars.
  Answers regularly exceed both — the renderer has to promote between
  three payload shapes (content → embed → file attachment).
- The gateway gives us `3 s` to acknowledge an interaction, then ≤ 15 min
  to edit the follow-up reply. `deferReply()` claims the 15-min window.
- dcs-agent can take minutes on a hard question. The bot is I/O-bound
  the whole time; there's no work to do except reflect state into Discord.

---

## 2. High-level shape

```
                 ┌──────────────────┐
                 │   Discord user   │
                 └────────┬─────────┘
                          │ /ask question:<…>
                          ▼
               ┌────────────────────┐
               │  Discord Gateway   │
               └────────┬───────────┘
                        │ InteractionCreate (WebSocket)
                        ▼
        ┌──────────────────────────────────────┐
        │              discord-bot             │
        │  ┌────────────┐     ┌─────────────┐  │
        │  │  index.ts  │────▶│ commands/   │  │
        │  │  (router)  │     │ ask.ts      │  │
        │  └────────────┘     └──────┬──────┘  │
        │                            │         │
        │        ┌───────────────────┼──────┐  │
        │        ▼                   ▼      ▼  │
        │  ┌──────────┐      ┌────────┐ ┌───── │
        │  │ userLock │      │ agent  │ │ stream│
        │  │          │      │ Client │ │Rendrer│
        │  └──────────┘      └────┬───┘ └──▲─── │
        │                         │        │   │
        │                         │        │   │
        └─────────────────────────┼────────┼───┘
                                  │        │
                          HTTP POST│        │ editReply
                          SSE      │        │ (REST)
                                  ▼        │
                       ┌────────────────────┐
                       │     dcs-agent      │
                       │  /api/research/    │
                       │     stream         │
                       └────────────────────┘
```

Everything flows through a single composition seam — `commands/ask.ts::execute`.
That function is the only place where Discord concerns (the interaction
object), agent concerns (the SSE client), rendering concerns (the stream
renderer), concurrency concerns (the user lock), and observability concerns
(the request-scoped logger) all meet.

---

## 3. Module map

```
src/
├── index.ts                    # entry point: login, interaction router, shutdown
├── config.ts                   # zod-validated env → typed config singleton
├── commands/
│   ├── index.ts                # command registry (map of name → command def)
│   └── ask.ts                  # /ask: the whole request lifecycle
├── agentClient.ts              # HTTP → SSE → typed AgentEvent stream
├── sseParser.ts                # pure SSE byte-stream → frame parser
├── streamRenderer.ts           # AgentEvent → Discord editReply payloads
├── concurrency/
│   └── userLocks.ts            # per-user Set-based "one /ask in flight" lock
├── observability/
│   ├── logger.ts               # pino + AsyncLocalStorage + Sentry bridge
│   └── sentry.ts               # conditional dynamic @sentry/node loader
├── scripts/
│   └── integration-test.ts     # end-to-end smoke test (bot ↔ agent, no Discord)
├── testUtils/
│   └── sseStream.ts            # ReadableStream fixture helper for tests
├── deploy-commands.ts          # one-shot: register /ask globally
├── deploy-commands-guild.ts    # one-shot: register /ask in one guild (dev loop)
├── sseParser.test.ts           # unit tests (14 cases)
└── streamRenderer.test.ts      # unit tests (14 cases)
```

**Module responsibilities at a glance**

| Module | Knows about | Doesn't know about |
|--------|-------------|--------------------|
| `index.ts` | discord.js client, command registry, lifecycle | SSE, rendering, the agent |
| `commands/ask.ts` | everything below — the composition point | how SSE frames are parsed |
| `agentClient.ts` | dcs-agent's HTTP shape, SSE event types | Discord, rendering |
| `sseParser.ts` | SSE wire format only | agent types, Discord |
| `streamRenderer.ts` | Discord payload shapes, throttle semantics | SSE, HTTP |
| `userLocks.ts` | `Set<userId>` membership | anything |
| `observability/*` | pino, Sentry, ALS | the bot's domain |

The *shape* of this module graph matters: the two non-trivial pure modules
(`sseParser`, `streamRenderer`) sit at the bottom of the dependency tree
and have no side effects. That's what makes them unit-testable in
isolation, and it's why they're the two files with a regression test
suite.

---

## 4. Request lifecycle — one `/ask`

Sequence, in time:

```
Discord                   index.ts           ask.ts            agentClient      dcs-agent
   │                         │                 │                   │               │
   │ interaction create ───▶ │                 │                   │               │
   │                         │ route /ask ───▶ │                   │               │
   │                         │                 │ tryAcquire(userId)│               │
   │                         │                 │   (or reply & return)            │
   │                         │                 │ withRequestContext│               │
   │                         │                 │ deferReply()                      │
   │ ◀── deferred ack ───────┼─────────────────┤                   │               │
   │                         │                 │ log "ask.start"   │               │
   │                         │                 │ for await event ─▶│ POST ─ SSE ─▶ │
   │                         │                 │                   │ ◀─ frames ──  │
   │                         │                 │ ◀─ AgentEvent ──  │               │
   │                         │                 │ renderer.handle   │               │
   │ ◀─ editReply ◀─────────────────────────────┤                   │               │
   │                         │                 │   …tokens stream, throttled       │
   │                         │                 │                   │               │
   │                         │                 │ renderer.finalize │               │
   │ ◀─ final editReply ◀───────────────────────┤                   │               │
   │                         │                 │ log "ask.done"    │               │
   │                         │                 │ release(userId)   │               │
```

The key invariants:

1. **`tryAcquire` is the first gate.** If it fails, we reply ephemerally
   and return — nothing else runs, no logger context is entered, no
   agent call is made. The original in-flight stream keeps running
   untouched.
2. **`withRequestContext` is the second gate.** Every `log.*` call
   inside the wrapped callback (including deep inside `streamRenderer`
   and `agentClient`) automatically carries `interactionId`, `userId`,
   `guildId`, `channelId`, `commandName`, `userTag` — without threading
   a logger parameter through five signatures.
3. **`release` runs in `finally`.** No matter how the handler exits —
   success, timeout, agent error, thrown network error, unexpected
   exception — the lock drops.

---

## 5. SSE parser (`sseParser.ts`)

Translates `ReadableStream<Uint8Array>` into an async iterator of
`SseFrame = { event: string; data: string }` per the
[SSE spec](https://html.spec.whatwg.org/multipage/server-sent-events.html).

**Why a custom parser and not `eventsource` / a library?** dcs-agent's
SSE is minimal (events we care about: `session`, `token`, `tool_start`,
`tool_end`, `done`, `error`), and we already have `fetch` + `ReadableStream`
in Node 20. The whole parser is 56 lines. A dependency would be larger
than the code.

**Semantics worth remembering**
- Multi-byte UTF-8 characters split across chunks are stitched by
  `TextDecoder({ stream: true })` — the parser doesn't have to handle it.
- `data:` lines within one frame are joined with `\n`.
- Frames with zero `data:` lines are silently dropped (null from
  `extractFrame`). Frames with a single `data:` line of empty string
  emit `{ event, data: "" }` — distinct from the null case.
- A trailing frame at stream close emits only if it had `data:` lines.
- The generator respects an optional `AbortSignal` at each loop iteration.

---

## 6. Agent client (`agentClient.ts`)

Wraps `sseParser` into the typed `AgentEvent` domain:

```ts
type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "token"; content: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; output: string }
  | { type: "done"; sessionId: string; messageCount: number }
  | { type: "error"; message: string };
```

Two error shapes distinguish the cause:

- `AgentHttpError(status, body)` — HTTP ≥ 400 from dcs-agent. The caller
  uses `status` to pick a user-facing message (401 → bad API key, 429 →
  rate-limited, etc.).
- `AgentNetworkError(message)` — couldn't reach the agent (connection
  refused, DNS, etc.). Distinct from an HTTP error because the remedy
  is different ("is the agent running?" vs "is the API key right?").

Unknown SSE event types are logged at `debug` (`sse.unknown_event`) and
skipped — we don't want a new agent event type to crash existing bot
deployments.

---

## 7. Stream renderer (`streamRenderer.ts`) — the tricky one

This is the only stateful module in the hot path. It absorbs agent
events and produces Discord `editReply` payloads.

### 7.1 State machine

Internal state:
```
answer:           string   // concatenated token content
tools:            string[] // ordered, deduped tool names
agentError:       string | null
lastEditAt:       number   // ms timestamp of the last COMPLETED edit
lastPayloadKey:   string   // JSON of the last dispatched payload
inFlight:         Promise  // chain of in-flight + queued edits
```

### 7.2 Three output shapes

`renderLive()` picks a shape based on content size:

| Total text size | Shape | Fields |
|-----------------|-------|--------|
| ≤ 1 900 chars | inline content | `{ content, embeds: [], files: [] }` |
| 1 901 – 4 000 chars (body) | embed | `{ content: <header>, embeds: [EmbedBuilder], files: [] }` |
| > 4 000 chars (body) | file attachment | `{ content: "…file…", embeds: [], files: [answer.md] }` |

The thresholds (`DISCORD_CONTENT_LIMIT = 1900`, `EMBED_DESC_LIMIT = 4000`)
are intentionally below Discord's 2 000 / 4 096 limits to leave headroom
for the "Q:" header and tool/error lines that get rendered alongside the
body.

File-attachment shape is **only selected in `finalize()`** — it would
be weird to see the answer flip from inline to attachment mid-stream.
While streaming, oversized answers live in the embed shape (truncated
with an ellipsis); finalize swaps to the file if the final length
crosses the embed limit.

### 7.3 Throttle: completion-to-completion, not dispatch-to-dispatch

Discord's edit rate limit is applied at the API. If we measured
"time since last *dispatch*", a slow edit (say, a 4 s Discord response)
would leave `throttleMs` elapsed while it's still in flight — we'd
happily dispatch a second edit that then piles up behind the first on
Discord's queue. A burst of a dozen tokens while one edit is pending
would queue a dozen more.

Instead we measure *completion-to-completion*: `lastEditAt` is set
inside `inFlight.then(...)` after `editReply` resolves. Combined with
`await inFlight` in `scheduleEdit`, a slow edit genuinely blocks the
next one.

This is exactly the behavior the regression test
`"measures the throttle completion-to-completion, not dispatch-to-dispatch"`
guards.

### 7.4 Identical-payload suppression

`lastPayloadKey = JSON.stringify(payload)` is compared against the
last dispatched key; equal payloads skip the edit. Avoids burning
edit budget on events that don't change the rendered output (e.g.
an empty-content token, or a duplicate `tool_start`).

### 7.5 Finalize

`finalize()` first `await inFlight.catch(() => undefined)` — guarantees
the final edit doesn't race with a trailing throttled edit and
overwrite it. Then it emits the final payload (with the file-vs-inline
decision above) without going through the throttle.

---

## 8. Concurrency lock (`concurrency/userLocks.ts`)

A `Set<userId>` — membership is all we need, we never await the
in-flight request. `tryAcquire` is the atomic
`if (!has) { add; return true }`; `release` is idempotent `delete`.

**Why reject, not queue.** Queueing a second `/ask` creates ambiguous
UX ("is mine stuck or is it just behind?"), complicates timeout
cancellation (whose timeout fires?), and encourages spam (users queue
more while waiting). Explicit rejection with an ephemeral hint is
immediate and honest.

**What this doesn't protect against**
- Multi-user swarming — a global cap is deferred to Tier 2 once we
  have instrumentation to size it.
- Process-crash leak — the Set lives in memory. A crash wipes it;
  Docker's `restart: unless-stopped` handles the restart. Acceptable.
- A user with two Discord accounts — out of scope.

---

## 9. Observability (`observability/`)

### 9.1 Logger (`logger.ts`)

pino v10, single root logger. `withRequestContext(ctx, fn)` uses Node's
`AsyncLocalStorage` to bind a child logger for the duration of `fn`'s
async subtree. The exported `log` is a `Proxy` that resolves the ALS
store on every access, so `log.info(…)` inside a deeply-nested `await`
picks up the bound child automatically.

**Why ALS over threaded parameters.** The bot is ~500 LOC with a
single entry point (`ask.ts::execute`) and a single non-branching
call tree (interaction → agentClient async iterator → renderer
callbacks). Native `async/await` and `for await` preserve ALS
context correctly on Node 20. Threading a `logger` argument through
five signatures would be pure ceremony.

**Pino hooks bridge to Sentry.** `hooks.logMethod` inspects every
log call; when `level >= 50` (error) and the payload includes an
`err` key, it forwards to `Sentry.captureException(err, { extra })`.
Call sites stay uniform: `log.error({ err, event: "..." }, "msg")`.

Transport is gated on `NODE_ENV`:
- production → default JSON stdout
- anything else → `pino-pretty` transport (installed as a devDep)

### 9.2 Sentry (`sentry.ts`)

When `SENTRY_DSN` is unset, `@sentry/node` is **never imported** —
the dynamic `import("@sentry/node")` is behind an env check. This
keeps the happy path zero-overhead. The public surface is a
`SentryLike` interface with two methods (`captureException`, `close`),
which is backed by a no-op stub until `initSentry()` runs with a DSN.

At-exit flush: the SIGINT/SIGTERM handlers in `index.ts` call
`getSentry().close(2000)` before `client.destroy()`. Docker's default
SIGTERM grace is 10 s, so a 2-s flush is safe.

### 9.3 Lifecycle events

Emitted from `ask.ts` around the stream loop. They turn "the bot
did something" into a structured event stream you can grep and graph:

| Event | Level | Fields |
|-------|-------|--------|
| `ask.start` | info | `questionPreview` |
| `ask.token_first` | debug | `latencyMs` (time-to-first-token) |
| `ask.tool_start` | info | `tool` (once per unique tool, deduped) |
| `ask.done` | info | `durationMs`, `totalChars`, `toolsUsed[]` |
| `ask.aborted` | info | `reason: "timeout" \| "agent_error"` |

Plus a handful of defensive `warn`/`error` events for edge cases
(`render.throttle_edit_failed`, `ask.handler_failed`, etc.) — see
the Plan doc or the source for the full list.

---

## 10. Testing strategy

Two tiers:

### 10.1 Unit tests — vitest, colocated

Pure-module tests: `sseParser.test.ts` (14 cases) and
`streamRenderer.test.ts` (14 cases). No Discord, no HTTP, no real
time — throttle-sensitive tests inject a custom `now: () => number`
and a stub `editReply` fn.

Current coverage (v8 reporter): 100 % lines, 94.82 % branches across
both files. The **critical** test is
`"measures the throttle completion-to-completion, not dispatch-to-dispatch"`
— it guards the bug fix that made the throttle actually work. Do not
delete it.

### 10.2 Integration test — `src/scripts/integration-test.ts`

End-to-end against a real dcs-agent (no Discord). Reads `AGENT_API_URL`
+ `AGENT_API_KEY` from env, POSTs a test question, iterates the SSE
stream, asserts on event counts and totals. Useful when bumping
dcs-agent versions or changing the wire contract.

Run: `npx tsx src/scripts/integration-test.ts` (or add a convenience
script to `package.json` if you run it often).

### 10.3 What we don't test (yet)

- `ask.ts::execute` end-to-end with a fake interaction. The composition
  is thin and most bugs surface in the unit-tested dependencies;
  adding this is deferred until we have a reason.
- Discord rate-limit behavior under real load.
- Recovery from a dcs-agent restart mid-stream — network/AbortError
  handling is exercised only by the integration test.

---

## 11. Operational notes

### Startup order
1. `config.ts` runs first (it's imported by everything) — validates
   env with zod, exits with a human-readable error on missing/malformed
   config.
2. `index.ts` top-level: `await initSentry()` (no-op unless DSN),
   wire up client listeners, `await client.login(...)`.
3. Discord sends `ClientReady` → `log.info({ event: "client.ready" })`.

### Shutdown
SIGTERM/SIGINT → `shutdown(signal)` → `getSentry().close(2000)` →
`client.destroy()` → `process.exit(0)`. Docker compose sends SIGTERM
with a 10-s grace by default; we're well inside it.

### Logs in production
Single-line JSON on stdout. `docker compose logs bot` is rotated
at 3 × 10 MB by the `json-file` driver (configured in
`docker-compose.yml`). Pipe through `jq` for human reading:
`docker compose logs bot | grep '^bot' | cut -d'|' -f2- | jq .`

### Failure modes and user-facing text
All in `ask.ts::buildErrorMessage`:

| Cause | User sees |
|-------|-----------|
| `AbortSignal` fired (timeout) | "The agent took too long to respond…" |
| HTTP 401 from agent | "Agent error (401 Unauthorized). Check the bot's AGENT_API_KEY." |
| HTTP 429 from agent | "The agent is rate-limiting requests. Try again in a moment." |
| Any other HTTP ≥ 400 | "Agent error (HTTP <n>). Try again in a moment." |
| `AgentNetworkError` | "Could not reach the agent. Is the dcs-agent server running?" |
| Anything else | "Something went wrong contacting the agent." |

User messages are deliberately short and actionable — not a stack
trace. The detail goes to logs + Sentry.

---

## 12. Key design decisions (one-line rationale)

| Decision | Why |
|----------|-----|
| Pure SSE parser, no library | 56 LOC, zero deps, deterministic |
| AsyncLocalStorage for logger context | Avoids threading `logger` arg through 5 signatures for a 500-LOC app |
| Conditional dynamic Sentry import | Zero cost when DSN unset; one API surface (log.error) when set |
| `Set<userId>` concurrency lock | Membership is all we need; no need to await the in-flight |
| Reject (not queue) second `/ask` | Unambiguous UX, no timeout-of-queued-work race |
| Throttle completion-to-completion | Dispatch-to-dispatch lets slow edits queue up, tripping the Discord limit |
| Three render shapes (content/embed/file) | Matches Discord's hard limits; chosen to leave headroom for headers |
| File shape only at `finalize()` | Avoids mid-stream payload shape flip that would confuse users |
| `vitest` with colocated tests | TS-native, ESM-friendly under `nodenext`, fast watch |

---

## 13. Extension points

**Adding a new slash command.**
1. Create `src/commands/<name>.ts` with `data: SlashCommandBuilder` and
   `execute(interaction)`.
2. Register it in `src/commands/index.ts`.
3. `npm run register-commands` (global) or `register-commands:guild`
   (dev loop) to publish the command definition to Discord.

**Adding a new agent event type.**
1. Extend `AgentEvent` in `agentClient.ts`.
2. Add a `case` in the `switch (frame.event)` block.
3. Handle it in `streamRenderer.ts::handle` (or extend state).
4. Update the unit tests.

**Adding conversation memory.** The agent already supports
`POST /api/research/:sessionId/stream` (resume a session). To wire it
in, persist `{ userId, channelId } → sessionId` (in memory for a first
pass, Redis/sqlite later) on `done` events, then route subsequent
`/ask` from the same `(user, channel)` pair through the resume
endpoint. See the Tier 2 out-of-scope notes in the Tier-1 plan for
details.

---

## 14. Deliberately out of scope

- CI/CD, GitHub Actions — add once there's a second contributor.
- ESLint, pre-commit hooks — TS strict catches most things.
- Prometheus / metrics export — pino events + Sentry cover today's
  needs; add when we want graphs.
- Distributed tracing — the interesting trace spans are all inside
  dcs-agent; add cross-service when that side is instrumented.
- Global concurrency cap — need real traffic data to size it.
- Coverage thresholds in CI — covered by convention today.
