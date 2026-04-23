import { parseSseStream } from "./sseParser.js";
import { log } from "./observability/logger.js";

export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "token"; content: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; output: string }
  | { type: "done"; sessionId: string; messageCount: number }
  | { type: "error"; message: string };

export class AgentHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Agent returned HTTP ${status}`);
    this.name = "AgentHttpError";
  }
}

export class AgentNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNetworkError";
  }
}

export interface AgentClient {
  streamResearch(
    question: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent>;
}

export interface AgentClientOptions {
  apiUrl: string;
  apiKey: string;
  /** Inject a custom fetch (e.g. for tests). Defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

export function createAgentClient(opts: AgentClientOptions): AgentClient {
  const baseUrl = opts.apiUrl.replace(/\/$/, "");
  const fetcher = opts.fetchFn ?? fetch;
  const apiKey = opts.apiKey;

  async function* streamResearch(
    question: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    let res: Response;
    try {
      res = await fetcher(`${baseUrl}/api/research/stream`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ question }),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new AgentNetworkError(
        err instanceof Error ? err.message : "Failed to reach agent",
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AgentHttpError(res.status, body);
    }
    if (!res.body) {
      throw new AgentNetworkError("Agent response had no body");
    }

    for await (const frame of parseSseStream(res.body, signal)) {
      const parsed = safeParseObject(frame.data);
      if (parsed === null) continue;

      switch (frame.event) {
        case "session":
          yield { type: "session", sessionId: String(parsed.sessionId ?? "") };
          break;
        case "token":
          yield { type: "token", content: String(parsed.content ?? "") };
          break;
        case "tool_start":
          yield {
            type: "tool_start",
            toolName: String(parsed.toolName ?? ""),
          };
          break;
        case "tool_end":
          yield {
            type: "tool_end",
            toolName: String(parsed.toolName ?? ""),
            output: String(parsed.output ?? ""),
          };
          break;
        case "done":
          yield {
            type: "done",
            sessionId: String(parsed.sessionId ?? ""),
            messageCount: Number(parsed.messageCount ?? 0),
          };
          return;
        case "error":
          yield {
            type: "error",
            message: String(parsed.message ?? "Agent reported an error"),
          };
          return;
        default:
          log.debug(
            {
              event: "sse.unknown_event",
              eventName: frame.event,
              dataPreview: frame.data.slice(0, 80),
            },
            "unknown agent SSE event",
          );
      }
    }
  }

  return { streamResearch };
}

function safeParseObject(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
