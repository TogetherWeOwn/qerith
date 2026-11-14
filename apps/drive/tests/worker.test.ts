import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import worker from '../src/worker';

test('the Worker denies requests before routing or serving assets', async () => {
  const response = worker.fetch();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'Service unavailable');
});
