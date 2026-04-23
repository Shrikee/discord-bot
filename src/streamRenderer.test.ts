import { describe, expect, it, vi } from "vitest";
import type { InteractionEditReplyOptions } from "discord.js";
import { createStreamRenderer } from "./streamRenderer.js";
import type { AgentEvent } from "./agentClient.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  editReply: ReturnType<typeof vi.fn>;
  renderer: ReturnType<typeof createStreamRenderer>;
  advance: (ms: number) => void;
  now: () => number;
}

function setup(opts?: {
  question?: string;
  throttleMs?: number;
  editReply?: (payload: InteractionEditReplyOptions) => Promise<unknown>;
}): Harness {
  let time = 1_000_000; // start far from 0 so the first throttle check passes
  const now = () => time;
  const advance = (ms: number): void => {
    time += ms;
  };
  const editReply = vi.fn(
    opts?.editReply ?? (async () => undefined),
  );
  const renderer = createStreamRenderer({
    editReply,
    question: opts?.question ?? "what is foo?",
    throttleMs: opts?.throttleMs ?? 1000,
    now,
  });
  return { editReply, renderer, advance, now };
}

async function flush(): Promise<void> {
  // Two ticks — one to let the inFlight chain settle, one to surface rejections.
  await Promise.resolve();
  await Promise.resolve();
}

const token = (content: string): AgentEvent => ({ type: "token", content });
const toolStart = (toolName: string): AgentEvent => ({
  type: "tool_start",
  toolName,
});
const errorEvent = (message: string): AgentEvent => ({
  type: "error",
  message,
});

describe("createStreamRenderer", () => {
  it("renders short content as inline text, no embed", async () => {
    const { renderer, editReply } = setup();
    await renderer.handle(token("hello world"));
    const payload = editReply.mock.calls[0]?.[0] as InteractionEditReplyOptions;
    expect(payload.embeds).toEqual([]);
    expect(payload.files).toEqual([]);
    expect(payload.content).toContain("**Q:** what is foo?");
    expect(payload.content).toContain("hello world");
  });

  it("promotes to an embed once content exceeds the inline limit", async () => {
    const { renderer, editReply } = setup();
    await renderer.handle(token("A".repeat(2000)));
    const payload = editReply.mock.calls.at(-1)?.[0] as InteractionEditReplyOptions;
    expect(payload.embeds).toHaveLength(1);
    expect(payload.files).toEqual([]);
    // Header (content) still present, embed carries the body.
    expect(payload.content).toContain("**Q:** what is foo?");
  });

  it("finalize() switches to a file attachment when answer > 4000 chars", async () => {
    const { renderer, editReply } = setup();
    await renderer.handle(token("B".repeat(5000)));
    editReply.mockClear();
    await renderer.finalize();
    const payload = editReply.mock.calls.at(-1)?.[0] as InteractionEditReplyOptions;
    expect(payload.files).toHaveLength(1);
    expect(payload.embeds).toEqual([]);
    expect(payload.content).toContain("_Answer attached as file._");
  });

  it("throttles consecutive edits within the throttle window", async () => {
    const { renderer, editReply, advance } = setup({ throttleMs: 1000 });
    await renderer.handle(token("first "));
    expect(editReply).toHaveBeenCalledTimes(1);

    // Second call immediately — still within throttle of completion-1.
    advance(500);
    await renderer.handle(token("second "));
    expect(editReply).toHaveBeenCalledTimes(1);

    // Advance past the window and try again.
    advance(600); // total 1100 since completion
    await renderer.handle(token("third"));
    expect(editReply).toHaveBeenCalledTimes(2);
  });

  it("measures the throttle completion-to-completion, not dispatch-to-dispatch", async () => {
    // Regression guard — the throttle window should only start when the
    // previous editReply resolves, so a slow Discord API doesn't let a burst
    // of edits queue up behind a single in-flight edit.
    const edits: Array<Deferred<undefined>> = [];
    const editReply = vi.fn(async () => {
      const d = defer<undefined>();
      edits.push(d);
      return d.promise;
    });
    const { renderer, advance } = setup({ throttleMs: 1000, editReply });

    // First handle — dispatches edit #1; scheduleEdit awaits inFlight, which is
    // pending because we haven't resolved `edits[0]`. Fire-and-forget.
    const first = renderer.handle(token("A"));
    await flush();
    expect(edits).toHaveLength(1); // dispatched, in-flight

    // 2 seconds pass during the slow edit…
    advance(2000);
    // …then edit #1 finishes. lastEditAt is set to now() = 1_000_000 + 2000.
    edits[0]!.resolve(undefined);
    await first;

    // Immediately after completion — diff is 0, must throttle.
    await renderer.handle(token("B"));
    expect(edits).toHaveLength(1); // still only one edit dispatched

    // Advance to just under throttleMs from completion — still throttled.
    advance(999);
    await renderer.handle(token("C"));
    expect(edits).toHaveLength(1);

    // Advance past the window — now the next edit is allowed. Fire-and-forget:
    // awaiting handle() here would deadlock because editReply is deferred and
    // we haven't resolved edits[1] yet.
    advance(2);
    const fourth = renderer.handle(token("D"));
    await flush();
    expect(edits).toHaveLength(2);
    edits[1]!.resolve(undefined);
    await fourth;
  });

  it("suppresses an edit when the computed payload is identical to the last one", async () => {
    const { renderer, editReply, advance } = setup({ throttleMs: 1000 });
    await renderer.handle(token("same"));
    expect(editReply).toHaveBeenCalledTimes(1);

    // Advance past the throttle but trigger a handle() that mutates no state
    // in a way that changes the rendered payload. Use a token with empty
    // content — the payload key won't change because `answer` is unchanged.
    advance(2000);
    await renderer.handle(token(""));
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates repeated tool_start events for the same tool name", async () => {
    const { renderer, editReply, advance } = setup({ throttleMs: 1000 });
    await renderer.handle(toolStart("search"));
    advance(2000);
    await renderer.handle(toolStart("search"));
    // The rendered payload includes `_using: search_` exactly once.
    const payload = editReply.mock.calls.at(-1)?.[0] as InteractionEditReplyOptions;
    const content = String(payload.content ?? "");
    const matches = content.match(/using: search/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("finalize() waits for the in-flight throttled edit before issuing its own", async () => {
    const edits: Array<Deferred<undefined>> = [];
    const editReply = vi.fn(async () => {
      const d = defer<undefined>();
      edits.push(d);
      return d.promise;
    });
    const { renderer } = setup({ throttleMs: 1000, editReply });

    const h = renderer.handle(token("A"));
    await flush();
    expect(edits).toHaveLength(1);

    // Kick off finalize BEFORE resolving the in-flight edit.
    const f = renderer.finalize();

    // finalize() must not have issued its edit yet — the inFlight chain is still
    // pending, and finalize awaits it.
    await flush();
    expect(edits).toHaveLength(1);

    // Resolve the in-flight edit; finalize should now issue its own. Can't
    // await f before resolving edits[1] or we deadlock — finalize's own
    // editReply call creates a second pending deferred.
    edits[0]!.resolve(undefined);
    await h;
    await flush();
    expect(edits).toHaveLength(2);
    edits[1]!.resolve(undefined);
    await f;
  });

  it("surfaces agent error events in the rendered payload", async () => {
    const { renderer, editReply } = setup();
    await renderer.handle(errorEvent("the agent exploded"));
    const payload = editReply.mock.calls.at(-1)?.[0] as InteractionEditReplyOptions;
    expect(String(payload.content)).toContain(
      "_Agent error: the agent exploded_",
    );
  });

  it("swallows editReply rejections in the throttled chain without bubbling them", async () => {
    const editReply = vi.fn(async () => {
      throw new Error("discord-500");
    });
    const { renderer } = setup({ throttleMs: 1000, editReply });

    // Should not throw, even though editReply rejects.
    await expect(renderer.handle(token("X"))).resolves.toBeUndefined();
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  it("swallows finalize() editReply rejection in the file-attachment branch", async () => {
    // First call (during handle) succeeds, second call (from finalize) rejects.
    let call = 0;
    const editReply = vi.fn(async (_p: InteractionEditReplyOptions) => {
      call++;
      if (call >= 2) throw new Error("discord-500-final-file");
      return undefined;
    });
    const { renderer } = setup({ throttleMs: 1000, editReply });

    await renderer.handle(token("B".repeat(5000)));
    await expect(renderer.finalize()).resolves.toBeUndefined();
    // Finalize must have attempted the file-attachment edit.
    const last = editReply.mock.calls.at(-1)?.[0] as InteractionEditReplyOptions;
    expect(last.files).toHaveLength(1);
  });

  it("promotion-to-embed includes tools and agentError in the content header", async () => {
    const { renderer, editReply, advance } = setup({ throttleMs: 1000 });
    await renderer.handle(toolStart("search"));
    advance(2000);
    await renderer.handle(errorEvent("boom"));
    advance(2000);
    // Push answer past the inline limit to force embed promotion.
    await renderer.handle(token("A".repeat(2000)));

    const payload = editReply.mock.calls.at(-1)?.[0] as InteractionEditReplyOptions;
    expect(payload.embeds).toHaveLength(1);
    const content = String(payload.content ?? "");
    // Both the tool line and the error line belong in the header when the
    // body is promoted to an embed.
    expect(content).toContain("_using: search_");
    expect(content).toContain("_Agent error: boom_");
  });

  it("finalize() file-attachment branch embeds tools and agentError in the body", async () => {
    const { renderer, editReply } = setup();
    await renderer.handle(toolStart("search"));
    await renderer.handle(errorEvent("boom"));
    await renderer.handle(token("C".repeat(5000)));
    editReply.mockClear();
    await renderer.finalize();

    const payload = editReply.mock.calls.at(-1)?.[0] as InteractionEditReplyOptions;
    expect(payload.files).toHaveLength(1);
    const content = String(payload.content ?? "");
    expect(content).toContain("_tools used: search_");
    expect(content).toContain("_Agent error: boom_");
    expect(content).toContain("_Answer attached as file._");
  });

  it("swallows finalize() editReply rejection in the inline branch", async () => {
    let call = 0;
    const editReply = vi.fn(async (_p: InteractionEditReplyOptions) => {
      call++;
      if (call >= 2) throw new Error("discord-500-final-inline");
      return undefined;
    });
    const { renderer } = setup({ throttleMs: 1000, editReply });

    await renderer.handle(token("short"));
    await expect(renderer.finalize()).resolves.toBeUndefined();
    const last = editReply.mock.calls.at(-1)?.[0] as InteractionEditReplyOptions;
    expect(last.files).toEqual([]);
  });
});
