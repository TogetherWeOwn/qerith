import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const configPath = 'wrangler.staging.json';
const entryPath = '.svelte-kit/cloudflare/_worker.js';
const assetsPath = '.svelte-kit/cloudflare';

function requireContained(root, relative, type) {
  const actual = realpathSync(resolve(root, relative));
  if (!actual.startsWith(`${realpathSync(root)}${sep}`) || !statSync(actual)[type]()) {
    throw new Error(`invalid staging ${relative}`);
  }
}

export function publishStaging(root, run = execFileSync) {
  requireContained(root, configPath, 'isFile');
  requireContained(root, entryPath, 'isFile');
  requireContained(root, assetsPath, 'isDirectory');
  const config = JSON.parse(readFileSync(resolve(root, configPath), 'utf8'));
  if (config.name !== 'qerith-drive-staging' || config.main !== entryPath ||
      config.assets?.directory !== assetsPath || config.assets?.binding !== 'ASSETS' ||
      config.assets?.run_worker_first !== true || config.env !== undefined) {
    throw new Error('invalid staging Worker configuration');
  }
  requireContained(root, 'node_modules/.bin/wrangler', 'isFile');
  run(resolve(root, 'node_modules/.bin/wrangler'), ['deploy', entryPath, '--config', configPath], {
    cwd: root,
    stdio: 'inherit',
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('publish accepts no arguments');
  publishStaging(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
}
