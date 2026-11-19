import { spawn } from 'node:child_process';
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

export function validateStagingTarget(root, accountId) {
  if (accountId !== '209cf7dd678adfb683947dd7874d05af') {
    throw new Error('invalid staging Cloudflare account');
  }
  requireContained(root, configPath, 'isFile');
  requireContained(root, entryPath, 'isFile');
  requireContained(root, assetsPath, 'isDirectory');
  const config = JSON.parse(readFileSync(resolve(root, configPath), 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).sort().join(',') !== 'assets,compatibility_date,compatibility_flags,d1_databases,main,name' ||
      config.compatibility_date !== '2026-07-30' ||
      !Array.isArray(config.compatibility_flags) || config.compatibility_flags.length !== 2 ||
      config.compatibility_flags[0] !== 'nodejs_compat' || config.compatibility_flags[1] !== 'enable_request_signal' ||
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
}

export function publishStaging(root, run = spawn, accountId = process.env.CLOUDFLARE_ACCOUNT_ID) {
  validateStagingTarget(root, accountId);
  return new Promise((resolveRun, reject) => {
      const child = run(resolve(root, 'node_modules/.bin/wrangler'), ['deploy', entryPath, '--config', configPath], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let failed = false;
      const stop = () => {
        failed = true;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      };
      const timer = setTimeout(stop, 110000);
      for (const stream of [child.stdout, child.stderr]) {
        let bytes = 0;
        stream.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) stop(); });
        stream.on('error', stop);
      }
      child.on('error', stop);
      child.on('close', code => {
        clearTimeout(timer);
        if (failed || code !== 0) reject(); else resolveRun();
      });
  }).catch(() => {
    // Provider diagnostics are untrusted and may include sensitive information.
    throw new Error('staging Worker publication failed');
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--check-target') {
    validateStagingTarget(process.cwd(), process.env.CLOUDFLARE_ACCOUNT_ID);
  } else if (process.argv.length === 3 && process.argv[2] === '--publish') {
    publishStaging(process.cwd());
  } else {
    throw new Error('unrecognized staging publisher arguments');
  }
}
