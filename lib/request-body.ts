// Request-body lifecycle for POST handlers. Every return path must finalize the request body: a
// response sent while the body is still unread leaves the runtime reading a request stream it has
// already answered. Under local `wrangler dev` that is an uncaught "Can't read from request stream
// after response has been sent" in the dev proxy, and the next request fails.

// Upper bounds for discarding a body the handler does not use. Bytes are read and dropped, never
// buffered; past either limit the rest of the body is cancelled.
const DISCARD_LIMIT_BYTES = 64 * 1024;
const DISCARD_TIMEOUT_MS = 1000;

// Finalizes a body the handler will not read (early rejections, and routes that take no payload).
// Best effort: it never throws, so it cannot replace the response the caller is about to return.
export async function discardBody(request: Request): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    if (!request.body || request.bodyUsed) return;
    reader = request.body.getReader();
  } catch {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>(resolve => { timer = setTimeout(resolve, DISCARD_TIMEOUT_MS, 'expired'); });
  try {
    for (let received = 0; received < DISCARD_LIMIT_BYTES;) {
      const chunk = await Promise.race([reader.read(), expired]);
      if (chunk === 'expired') break;
      if (chunk.done) return;
      received += chunk.value.byteLength;
    }
    reader.cancel().catch(() => {});
  } catch {
    // A body that fails while being discarded is finished either way.
  } finally {
    clearTimeout(timer);
  }
}

// Reads a JSON object body. Malformed JSON, or JSON that is not an object, is a client error, so it
// yields null for the caller to answer 400 before any storage or provider work.
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
