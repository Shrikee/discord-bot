# discord-bot

Discord slash-command client for the [dcs-agent](../dcs-agent) research backend.
Streams agent responses into Discord replies via SSE.

> **Looking for the internals?** See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for
> system design, module layout, and key decisions.

## Prerequisites

- Node.js ≥ 20
- A running dcs-agent server (see `../dcs-agent/README.md`)
- A Discord application + bot ([developer portal](https://discord.com/developers/applications))
  with the bot invited to a dev guild (scope: `applications.commands`)

## Setup

```bash
cp .env.example .env
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, AGENT_API_URL, AGENT_API_KEY
# DISCORD_GUILD_ID is optional — only needed for the dev-loop guild registration

npm install
```

`AGENT_API_KEY` must match the `API_KEY` in the dcs-agent's `.env`.

## Run

Three terminals:

```bash
# 1) Agent backend
cd ../dcs-agent && npm run dev

# 2) Register slash commands globally (once, or whenever command defs change).
#    /ask is registered as a GLOBAL command — it works in every server the
#    bot is in, but Discord takes up to ~1h to propagate after a first
#    register or any command-shape change.
npm run register-commands

# 3) Start the bot
npm run dev
```

In any server the bot is in, run `/ask question: <your question>`. The reply
updates progressively as tokens stream in.

### Dev loop: faster guild-scoped registration

Waiting ~1h for global propagation is painful while iterating on command
definitions. If `DISCORD_GUILD_ID` is set in `.env`, you can register the
same commands scoped to that one guild — it propagates instantly:

```bash
npm run register-commands:guild
```

Guild-scoped commands are independent of the global set, and only appear in
that specific server. Use this for iteration; use `npm run register-commands`
(global) before sharing the bot publicly.

### Production

`npm run dev` uses `tsx --watch` and is for development only. For production,
compile first and run the JS output:

```bash
npm run build && npm start
```

`build` invokes `tsc` (emits to `dist/`); `start` runs `node dist/index.js`.

## Deploy with Docker

For long-running deployments, use the included Dockerfile + Compose setup
instead of `tsx --watch`.

```bash
cp .env.example .env
# fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, AGENT_API_KEY
# (DISCORD_GUILD_ID is optional; AGENT_API_URL is overridden by compose)

docker compose build
docker compose up -d
docker compose logs -f bot   # should show {"event":"client.ready",...}
```

To ship a new version:

```bash
git pull
docker compose up -d --build
```

The bot is outbound-only (no exposed ports) and restarts automatically
(`unless-stopped`). Container logs are capped at 3 × 10 MB via the `json-file`
driver so they don't fill the disk.

### Reaching dcs-agent from the container

`docker-compose.yml` overrides `AGENT_API_URL` to
`http://host.docker.internal:3000`, which reaches the host's loopback from
inside the container. This works in both setups:

- **dcs-agent runs natively on the host** (`npm run dev` / `npm start` in
  `../dcs-agent/`) — the host-gateway alias routes to the host's localhost.
- **dcs-agent runs in its own Compose stack** — its compose publishes
  `3000:3000`, so `host.docker.internal:3000` still reaches it via the host.

On Linux, `extra_hosts: ["host.docker.internal:host-gateway"]` in
`docker-compose.yml` is what makes the alias resolve. Docker Desktop on
macOS/Windows adds it automatically, but the entry is harmless there and
keeps the file portable.

If you'd rather put the bot on dcs-agent's Docker network and address it by
service name, edit `docker-compose.yml`:

```yaml
services:
  bot:
    # ...
    environment:
      AGENT_API_URL: http://app:3000   # 'app' is dcs-agent's service name
    networks:
      - dcs-agent_default              # external network from dcs-agent's compose

networks:
  dcs-agent_default:
    external: true
```

Start dcs-agent first (`cd ../dcs-agent && docker compose up -d`) so the
network exists before bringing the bot up.

## Behavior

- Every `/ask` starts a fresh agent session (no conversation memory in this MVP).
- Long answers switch to an embed (>1 900 chars) and then to a `.md` file
  attachment (>4 000 chars).
- Reply edits are throttled (see `EDIT_THROTTLE_MS`) to stay below Discord's
  ~5 edits / 5 s per-channel bucket. 1 000 ms is a safe default.
- **Per-user concurrency lock**: each Discord user can have at most one `/ask`
  in flight at a time. A second `/ask` from the same user while the first is
  still streaming gets an ephemeral "you already have a `/ask` in progress"
  reply — the original stream is untouched and completes normally.
- The first request after a cold agent start may be slow (model warm-up,
  Chroma connection, etc.).

## Observability

Structured JSON logging via [pino](https://getpino.io/), with optional Sentry
error reporting. A request-scoped logger (bound to `interactionId`, `userId`,
`guildId`, `channelId`, `commandName`, `userTag`) is propagated through the
`/ask` call tree via `AsyncLocalStorage` — every downstream `log.*` call
automatically carries the right context with no parameter-threading.

Logs are single-line JSON in production (`NODE_ENV=production`) and
pretty-printed during `npm run dev`. Lifecycle events emitted per `/ask`:

| Event | Level | Fields |
|-------|-------|--------|
| `ask.start` | info | `questionPreview` |
| `ask.token_first` | debug | `latencyMs` |
| `ask.tool_start` | info | `tool` |
| `ask.done` | info | `durationMs`, `totalChars`, `toolsUsed` |
| `ask.aborted` | info | `reason: "timeout" \| "agent_error"` |

### Sentry

Sentry is **off by default**. When `SENTRY_DSN` is unset, `@sentry/node` is
never even imported — there's zero runtime overhead on the happy path.
Setting `SENTRY_DSN` activates it on the next restart, and any `log.error({ err, … })`
call flows through a pino hook to `Sentry.captureException(err, { extra })`.
Use one API (`log.error`), not two.

## Testing

Unit tests for the two pure modules that matter (`sseParser.ts` and
`streamRenderer.ts`):

```bash
npm test               # run once
npm run test:watch     # vitest watch mode
npm run test:coverage  # v8 coverage, text summary to stdout
```

## Config

| Var | Default | Purpose |
|-----|---------|---------|
| `DISCORD_TOKEN` | — | Bot token |
| `DISCORD_CLIENT_ID` | — | Application ID |
| `DISCORD_GUILD_ID` | — | Optional, dev-only. Guild ID for `register-commands:guild` (instant propagation, single server). |
| `AGENT_API_URL` | `http://localhost:3000` | dcs-agent base URL |
| `AGENT_API_KEY` | — | Same as dcs-agent's `API_KEY` |
| `AGENT_REQUEST_TIMEOUT_MS` | `600000` | Abort the stream after N ms |
| `EDIT_THROTTLE_MS` | `1000` | Minimum gap between reply edits |
| `LOG_LEVEL` | `info` | Pino log level: `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `SENTRY_DSN` | — | Optional. When unset, `@sentry/node` is not loaded. |
| `SENTRY_ENVIRONMENT` | `production` | Sentry environment tag |
| `RELEASE` | — | Optional release identifier (git SHA or semver) for Sentry |

## Troubleshooting

- **`/ask` replies "Agent error (401)"** — `AGENT_API_KEY` doesn't match the
  agent's `API_KEY`.
- **`/ask` replies "Could not reach the agent"** — dcs-agent isn't running or
  `AGENT_API_URL` is wrong.
- **`/ask` replies "You already have a `/ask` in progress"** — expected; the
  per-user lock is active. Wait for the first to finish.
- **Commands don't show up** — for global registration, Discord can take up
  to ~1h to propagate; try again later, or use `npm run register-commands:guild`
  for instant iteration in your dev guild. Also make sure the bot was invited
  with the `applications.commands` scope.
- **Reply never updates** — grep container logs for
  `"event":"render.throttle_edit_failed"`. Usually a channel permission issue.
- **Bot logs JSON like `{"level":40,"event":"command.error",...}`** — that's
  correct in production. Pipe through `jq` for readability, or set
  `NODE_ENV=development` locally to get pretty output.
