import { mkdtempDisposableSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const maxOutput = 65_536;
const timeout = 110_000;

// Only the version upload command is allowed here. In particular, do not set
// secrets through --secrets-file: require the pinned Wrangler to inherit them.
export async function uploadVersion(root, config, vars, tag, secrets, account, token, signal, run) {
  try {
    signal?.throwIfAborted();
    using dir = mkdtempDisposableSync(join(tmpdir(), 'drive-qualification-upload-'));
    const file = join(dir.path, 'wrangler.json');
    const output = join(dir.path, 'output.jsonl');
    const emptyEnv = join(dir.path, 'empty.env');
    const writePrivate = (path, content) => writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
    writePrivate(file, JSON.stringify({ ...config, main: join(root, config.main),
      assets: { ...config.assets, directory: join(root, config.assets.directory) },
      d1_databases: config.d1_databases.map(db => ({ ...db, migrations_dir: join(root, db.migrations_dir) })),
      vars, version_metadata: { binding: 'DRIVE_QUALIFICATION_VERSION' },
      secrets: { required: secrets }, send_metrics: false,
    }));
    writePrivate(output, '');
    writePrivate(emptyEnv, '');
    const args = ['versions', 'upload', '--config', file, '--env-file', emptyEnv, '--tag', tag];
    const env = { PATH: process.env.PATH, HOME: dir.path, CI: 'true', CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_API_TOKEN: token, WRANGLER_OUTPUT_FILE_PATH: output, WRANGLER_LOG_PATH: dir.path };

    await new Promise((resolve, reject) => {
      const deadline = performance.now() + timeout;
      const child = run(join(root, 'node_modules/.bin/wrangler'), args, {
        cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let failed = false;
      const stop = () => {
        failed = true;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      };
      const timer = setTimeout(stop, timeout);
      for (const stream of [child.stdout, child.stderr]) {
        let bytes = 0;
        stream.on('data', chunk => { bytes += chunk.length; if (bytes > maxOutput) stop(); });
        stream.on('error', stop);
      }
      child.on('error', stop);
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', stop);
        if (failed || code !== 0 || performance.now() >= deadline) reject(); else resolve();
      });
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
    });

    signal?.throwIfAborted();
    if (statSync(output).size > maxOutput) throw new Error();
    const records = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const uploads = records.filter(record => record.type === 'version-upload');
    if (uploads.length !== 1 || uploads[0].version !== 1 || uploads[0].worker_name !== config.name ||
        uploads[0].worker_name_overridden !== false || uploads[0].preview_url || uploads[0].preview_alias_url) throw new Error();
    return uploads[0].version_id;
  } catch {
    throw new Error('Staging Worker version upload could not be verified.');
  }
}
