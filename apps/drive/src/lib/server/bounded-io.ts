export class IoDeadlineExceeded extends DOMException {
  constructor() { super('I/O deadline exceeded', 'TimeoutError'); }
}

type IoDeadline = { signal: AbortSignal; check(): void };

/** The operation must observe the signal while waiting and check it before dispatching more I/O. */
export async function withIoDeadline<T>(timeoutMs: number, caller: AbortSignal | undefined,
  run: (deadline: IoDeadline) => Promise<T>): Promise<T> {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) {
    throw new RangeError('Invalid I/O timeout');
  }
  const timeout = new AbortController();
  const signal = caller ? AbortSignal.any([caller, timeout.signal]) : timeout.signal;
  const deadline = performance.now() + timeoutMs;
  const expire = () => timeout.abort(new IoDeadlineExceeded());
  const check = () => {
    if (!signal.aborted && performance.now() >= deadline) expire();
    signal.throwIfAborted();
  };
  const timer = setTimeout(expire, timeoutMs);
  try {
    // Run even with an already-aborted caller so it can dispose of I/O it owns.
    const result = await run({ signal, check });
    check();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type BodyBounds = {
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  exact?: boolean;
  maxReads?: number;
};

/** Returns null for a body outside its bounds. Stream errors and abort reasons propagate. */
export async function readBoundedBody(body: ReadableStream<Uint8Array>,
  { signal: caller, timeoutMs, maxBytes, exact, maxReads = Infinity }: BodyBounds): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid body limit');
  return withIoDeadline(timeoutMs, caller, async ({ signal, check }) => {
    const reader = body.getReader();
    // Cancelling settles a pending read even if the source never finishes teardown.
    const cancel = (reason?: unknown) => { void reader.cancel(reason).catch(() => {}); };
    const onAbort = () => cancel(signal.reason);
    let ended = false;
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      if (signal.aborted) onAbort();
      check();
      const bytes = new Uint8Array(maxBytes);
      let offset = 0;
      for (let reads = 1; reads <= maxReads; reads++) {
        const { done, value } = await reader.read();
        check();
        if (done) {
          ended = true;
          return exact && offset !== maxBytes ? null : bytes.subarray(0, offset);
        }
        if (value.byteLength > maxBytes - offset) return null;
        bytes.set(value, offset);
        offset += value.byteLength;
        // Ready reads, including empty chunks, must yield to the Workers timer.
        if (reads % 64 === 0 && reads < maxReads) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          check();
        }
      }
      return null;
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (!ended && !signal.aborted) cancel();
      reader.releaseLock();
    }
  });
}
