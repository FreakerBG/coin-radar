// Request-body lifecycle. A response returned while the request body is still unread leaves the
// runtime reading a request stream it has already answered: workerd reports an uncaught "Can't read
// from request stream after response has been sent" (cloudflare/workerd#918). Under local
// `wrangler dev` that happens inside Wrangler's dev proxy, and the next request fails or hangs.
// workerd's documented workaround, also used by Miniflare's own proxy, is to consume the body
// completely before responding. Cancelling it is not enough, and vinext cancels a body the route
// did not read, so worker/entry.ts keeps the original body out of vinext's reach.

// Calls `handle` with a request whose body is a pull-through view of the original: nothing is read
// ahead or buffered, and cancelling the view (as vinext does) leaves the original untouched. Once
// `handle` settles, whatever the application did not read of the original is read to the end and
// dropped, and only then is the response returned. There is deliberately no size or time cutoff,
// because cancelling an unfinished body brings the failure back: a client that sends slowly delays
// only its own response, until it finishes, disconnects or the platform ends the request. A body
// that fails (for example because the client disconnected) is finished too; that never changes the
// response.
export async function withFinishedBody(request: Request, handle: (request: Request) => Promise<Response>): Promise<Response> {
  if (!request.body) return handle(request);
  const original = request.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await original.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
  }, {highWaterMark: 0});
  try {
    // `duplex: 'half'` is the standard option for a streamed request body.
    return await handle(new Request(request, {body, duplex: 'half'} as RequestInit));
  } finally {
    try {
      while (!(await original.read()).done) {
        // Drop the chunk.
      }
    } catch {
      // An aborted or failed body is finished either way.
    }
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
