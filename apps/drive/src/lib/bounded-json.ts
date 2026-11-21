function parseUniqueJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  // With valid syntax, a string followed by a colon is a member name. Match whole
  // strings so braces and colons inside them cannot affect object boundaries.
  const objects: Set<string>[] = [];
  for (const [token, key, colon] of text.matchAll(/("(?:[^"\\]|\\.)*")([ \t\r\n]*:)?|[{}]/gs)) {
    if (token === '{') objects.push(new Set());
    else if (token === '}') objects.pop();
    else if (colon) {
      const keys = objects[objects.length - 1];
      const name = JSON.parse(key) as string;
      if (keys.has(name)) return null;
      keys.add(name);
    }
  }
  return parsed;
}

export async function readJsonWithin(response: Response, limit: number): Promise<unknown> {
  if (!response.body || response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json')
    return null;
  const reader = response.body.getReader(), bytes = new Uint8Array(limit);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return parseUniqueJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
      if (value.byteLength > limit - offset) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}
