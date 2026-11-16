import assert from 'node:assert/strict';
import test from 'node:test';
import { handle } from '../src/hooks.server';

for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
  test(`${method} requests fail closed without resolving a route`, async () => {
    let resolved = false;
    const response = await handle({
      event: { request: new Request('https://example.test/private', { method }) },
      resolve: async () => {
        resolved = true;
        return new Response('unexpected');
      }
    } as Parameters<typeof handle>[0]);

    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(resolved, false);
  });
}
