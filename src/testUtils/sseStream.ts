/**
 * Test fixture: turn a list of string chunks into a `ReadableStream<Uint8Array>`
 * suitable for feeding `parseSseStream`. Each string becomes a separate chunk —
 * use that to simulate network-boundary splits mid-frame.
 */
export function makeStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const s of chunks) controller.enqueue(encoder.encode(s));
      controller.close();
    },
  });
}

/**
 * A stream that never closes — use with an external abort signal to test
 * aborted-mid-iteration paths.
 */
export function makePendingStream(
  initialChunks: string[] = [],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const s of initialChunks) controller.enqueue(encoder.encode(s));
      // intentionally do not call controller.close()
    },
  });
}
