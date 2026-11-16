import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import worker from '../src/worker';

for (const file of ['wrangler.jsonc', 'wrangler.build.jsonc']) {
  test(`${file} routes assets through the fail-closed entrypoint`, () => {
    const config = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.equal(config.main, 'src/worker.ts');
    assert.equal(config.assets.run_worker_first, true);
  });
}

test('the Worker denies requests before routing or serving assets', async () => {
  const response = worker.fetch();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'Service unavailable');
});
