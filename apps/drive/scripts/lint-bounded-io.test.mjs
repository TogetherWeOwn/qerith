import assert from 'node:assert/strict';
import test from 'node:test';
import { lintSource } from './lint-bounded-io.mjs';

test('accepts shared I/O and Response.json output in server code', () => {
  const code = `
    await readBoundedBody(request.body, { signal: request.signal, timeoutMs: 2000, maxBytes: 128 });
    await withIoDeadline(2000, request.signal, ({ signal }) => fetch(url, { signal }));
    return Response.json({ ok: true });
  `;
  assert.deepEqual(lintSource('src/lib/server/new-route.ts', code), []);
});

test('rejects new body consumers and direct deadlines with a shared helper diagnostic', () => {
  const path = 'src/lib/server/new-route.ts';
  for (const [expression, rule] of [
    ['request.json()', 'direct body read'], ['response["arrayBuffer"]()', 'direct body read'],
    ['response.body\n  ?.getReader()', 'direct body read'], ['(await fetch(url)).text()', 'direct body read'],
    ['request.formData()', 'direct body read'], ['response.blob()', 'direct body read'],
    ['(response.body?.pipeTo)(sink)', 'direct body read'],
    ['for await (const chunk of response.body) { consume(chunk); }', 'direct body read'],
    ['response.bytes()', 'direct body read'], ['globalThis.AbortSignal["timeout"](5000)', 'direct I/O timeout'],
    ['performance.now() + timeoutMs', 'manual I/O deadline'],
    ['timeoutMs + (performance.now())', 'manual I/O deadline'],
    ['setTimeout(() => controller.abort(reason), 5000)', 'timer that aborts or cancels I/O'],
  ]) {
    assert.deepEqual(lintSource(path, `\n${expression}`), [
      `${path}:2: ${rule}. Use src/lib/server/bounded-io.ts (readBoundedBody or withIoDeadline).`,
    ]);
  }
});

test('applies to server entry points and leaves browser code and test fixtures outside the lint', () => {
  for (const path of ['src/worker.ts', 'src/hooks.server.ts', 'src/routes/+server.js',
    'src/routes/api/files/[id]/+server.ts', 'src/routes/+page.server.ts']) {
    assert.equal(lintSource(path, 'response.json()').length, 1, path);
  }
  for (const path of ['src/lib/browser.ts', 'src/hooks.client.ts', 'src/routes/+page.ts',
    'src/lib/server/request.test.ts', 'src/lib/server/bounded-io.ts', 'scripts/qualification.mjs']) {
    assert.deepEqual(lintSource(path, 'response.json()'), [], path);
  }
});

test('checks executable code in the generated Worker template at its source line', () => {
  const config = [
    'const build = () => writeFileSync(resolve(config.assets.directory, "_worker.js"), `',
    'const assets = ${JSON.stringify(',
    '  generatedAssets(builder)',
    ')};',
    'export default { async fetch(request) { return Response.json(await request.json()); } };',
    '`);',
  ].join('\n');
  assert.match(lintSource('vite.config.js', config)[0], /^vite\.config\.js:5: direct body read/);
  assert.deepEqual(lintSource('vite.config.js', config.replace('await request.json()', 'assets')), []);
  assert.match(lintSource('vite.config.js', 'export default {};')[0], /unable to locate the generated Worker template/);
  assert.match(lintSource('vite.config.js', config.replace('JSON.stringify', 'renderCode'))[0], /unable to locate/);
});

test('accepts an elapsed CPU yield interval and rejects an absolute deadline', () => {
  const path = 'src/lib/server/example.ts';
  assert.deepEqual(lintSource(path, 'if (performance.now() - lastYield >= 4) await yieldToTimer();'), []);
  assert.match(lintSource(path, 'const deadline = performance.now() + 4;')[0], /manual I\/O deadline/);
});

test('existing allowances match only their file and expression count and must shrink on removal', () => {
  const path = 'src/lib/server/s3/objects.ts';
  assert.deepEqual(lintSource(path, 'body.getReader()'), []);
  assert.match(lintSource(path, 'body.getReader();\nbody.getReader()')[0], /:2: direct body read/);
  assert.match(lintSource(path, 'other.getReader()')[0], /:1: direct body read/);
  assert.match(lintSource(path, '')[0], /remove 1 unused bounded I\/O allowance/);
  assert.equal(lintSource('src/lib/server/new.ts', 'body.getReader()').length, 1);
});
