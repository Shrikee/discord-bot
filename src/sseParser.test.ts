import { describe, expect, it } from "vitest";
import { parseSseStream, type SseFrame } from "./sseParser.js";
import { makeStream, makePendingStream } from "./testUtils/sseStream.js";

async function collect(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of parseSseStream(stream, signal)) frames.push(frame);
  return frames;
}

describe("parseSseStream", () => {
  it("parses a single complete frame", async () => {
    const frames = await collect(
      makeStream(["event: token\ndata: hello\n\n"]),
    );
    expect(frames).toEqual([{ event: "token", data: "hello" }]);
  });

  it("concatenates multiple data: lines with \\n", async () => {
    const frames = await collect(
      makeStream(["event: token\ndata: line1\ndata: line2\n\n"]),
    );
    expect(frames).toEqual([{ event: "token", data: "line1\nline2" }]);
  });

  it("skips heartbeat comment lines starting with ':'", async () => {
    const frames = await collect(
      makeStream([":keepalive\nevent: token\ndata: hi\n\n"]),
    );
    expect(frames).toEqual([{ event: "token", data: "hi" }]);
  });

  it("buffers a frame split mid-field across two chunks", async () => {
    const frames = await collect(
      makeStream(["event: to", "ken\ndata: x\n\n"]),
    );
    expect(frames).toEqual([{ event: "token", data: "x" }]);
  });

  it("emits exactly one frame when split on the '\\n\\n' boundary", async () => {
    // Split point lands inside the two newlines that terminate the frame.
    const frames = await collect(
      makeStream(["event: token\ndata: x\n", "\n"]),
    );
    expect(frames).toEqual([{ event: "token", data: "x" }]);
  });

  it("stops iteration cleanly when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const frames = await collect(
      makePendingStream(["event: token\ndata: x\n\n"]),
      controller.signal,
    );
    expect(frames).toEqual([]);
  });

  it("emits frames with unknown event names (parser does not filter)", async () => {
    const frames = await collect(
      makeStream(["event: something_weird\ndata: payload\n\n"]),
    );
    expect(frames).toEqual([
      { event: "something_weird", data: "payload" },
    ]);
  });

  it("defaults event to 'message' when no event: line is present", async () => {
    const frames = await collect(makeStream(["data: body\n\n"]));
    expect(frames).toEqual([{ event: "message", data: "body" }]);
  });

  it("emits an empty-data frame for a 'data:' line with empty value", async () => {
    // Distinct from a frame with zero data: lines, which returns null.
    const frames = await collect(
      makeStream(["event: token\ndata:\n\n"]),
    );
    expect(frames).toEqual([{ event: "token", data: "" }]);
  });

  it("drops a trailing frame that contains no data: lines when the stream closes", async () => {
    const frames = await collect(
      makeStream(["event: token\ndata: x\n\n", "event: orphan"]),
    );
    // The "event: orphan" tail has no data line → extractFrame returns null.
    expect(frames).toEqual([{ event: "token", data: "x" }]);
  });

  it("emits a trailing frame if it does contain data: lines and the stream closes mid-buffer", async () => {
    // No trailing "\n\n" on the second frame — it relies on the EOF handler.
    const frames = await collect(
      makeStream(["event: a\ndata: 1\n\n", "event: b\ndata: 2"]),
    );
    expect(frames).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("strips the single leading space after 'data:'", async () => {
    const frames = await collect(makeStream(["data:  hello\n\n"]));
    // Per the spec, only the first space is stripped — the second remains.
    expect(frames).toEqual([{ event: "message", data: " hello" }]);
  });

  it("skips unrecognized fields and drops an empty frame embedded in a multi-frame chunk", async () => {
    // First frame has no `data:` line → extractFrame returns null → inner-loop
    // `if (frame)` falsey branch. Second frame has an unrecognized `id:` line →
    // the `else if (line.startsWith("data:"))` falsey branch inside extractFrame.
    const frames = await collect(
      makeStream([
        "event: header-only\n\nid: 42\nevent: token\ndata: hi\n\n",
      ]),
    );
    expect(frames).toEqual([{ event: "token", data: "hi" }]);
  });

  it("handles a multi-byte UTF-8 character split across two chunks", async () => {
    const encoder = new TextEncoder();
    const full = encoder.encode("data: 日本語\n\n");
    // Split mid-UTF-8 sequence (at byte 7 — middle of '日'). TextDecoder
    // with `stream: true` must stitch the halves.
    const a = full.slice(0, 7);
    const b = full.slice(7);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(a);
        c.enqueue(b);
        c.close();
      },
    });
    const frames: SseFrame[] = [];
    for await (const f of parseSseStream(stream)) frames.push(f);
    expect(frames).toEqual([{ event: "message", data: "日本語" }]);
  });
});
