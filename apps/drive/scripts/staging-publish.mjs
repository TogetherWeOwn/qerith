import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
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
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).sort().join(',') !== 'assets,compatibility_date,d1_databases,main,name' ||
      config.compatibility_date !== '2026-07-30' ||
      !Array.isArray(config.d1_databases) || config.d1_databases.length !== 1 ||
      !config.d1_databases[0] || typeof config.d1_databases[0] !== 'object' ||
      Object.keys(config.d1_databases[0]).sort().join(',') !== 'binding,database_id,database_name,migrations_dir' ||
      config.d1_databases[0].binding !== 'DB' ||
      config.d1_databases[0].database_name !== 'qerith-drive-staging' ||
      config.d1_databases[0].database_id !== '87ac8041-ad2d-4650-b0d7-05bb78846f60' ||
      config.d1_databases[0].migrations_dir !== 'migrations' ||
      !config.assets || typeof config.assets !== 'object' || Array.isArray(config.assets) ||
      Object.keys(config.assets).sort().join(',') !== 'binding,directory,run_worker_first' ||
      config.name !== 'qerith-drive-staging' || config.main !== entryPath ||
      config.assets.directory !== assetsPath || config.assets.binding !== 'ASSETS' ||
      config.assets.run_worker_first !== true) {
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
  throw new Error('staging publication is disabled until migration admission is implemented and reviewed');
}
