import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { relative } from 'node:path';

async function exercise(args, assertions) {
  const worker = spawn('./node_modules/.bin/wrangler', ['dev', ...args, '--local', '--ip', '127.0.0.1', '--port', '18787'], {
    env: { ...process.env, CI: 'true' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  worker.stdout.on('data', (chunk) => { output += chunk; });
  worker.stderr.on('data', (chunk) => { output += chunk; });
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      if (worker.exitCode !== null) throw new Error('Wrangler exited before readiness');
      try { await fetch('http://127.0.0.1:18787/'); ready = true; break; } catch { await delay(500); }
    }
    if (!ready) throw new Error('Wrangler readiness timed out');
    for (const [path, status, body] of assertions) {
      const response = await fetch(`http://127.0.0.1:18787${path}`);
      const text = await response.text();
      if (response.status !== status || (body && text !== body)) {
        throw new Error(`${path}: expected ${status} ${body}, got ${response.status} ${text.slice(0, 200)}`);
      }
    }
  } catch (error) {
    console.error(output);
    throw error;
  } finally {
    worker.kill('SIGTERM');
    if (worker.exitCode === null) await new Promise((resolve) => worker.once('exit', resolve));
  }
}

const root = '.svelte-kit/cloudflare';
const files = await readdir(root, { recursive: true, withFileTypes: true });
const file = files.find((entry) => entry.isFile() && relative(root, entry.parentPath).startsWith('_app'));
if (!file) throw new Error('No generated app asset found');
const asset = `${relative(root, file.parentPath)}/${file.name}`;
for (const config of ['wrangler.jsonc', 'wrangler.build.jsonc']) {
  await exercise(['--config', config], [['/', 503, 'Service unavailable'], [`/${asset}`, 503, 'Service unavailable']]);
}
await exercise(['.svelte-kit/cloudflare/_worker.js', '--config', 'wrangler.build.jsonc'], [['/', 503, 'Service unavailable']]);
await exercise(['tests/runtime-fixture.ts', '--config', 'wrangler.build.jsonc'], [['/', 200, 'runtime-ok']]);
console.log('Worker runtime smoke checks passed');
