import { randomBytes, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from 'miniflare'; // Locked by Wrangler.
import { unstable_splitSqlQuery } from 'wrangler';

// Rehearse the serving probes on the packaged Worker before any production write.
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const worker = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.NONE),
  modules: [{ type: 'ESModule', path: config.main }],
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  assets: { ...config.assets, routerConfig: { has_user_worker: true } },
  d1Databases: { DB: randomUUID() },
  bindings: config.vars,
  outboundService() { throw new Error('Production shell fixture forbids outbound requests'); },
}));

try {
  const db = await worker.getD1Database('DB');
  const migrations = config.d1_databases[0].migrations_dir;
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(join(migrations, file), 'utf8');
    await db.batch(unstable_splitSqlQuery(sql).map(statement => db.prepare(statement)));
  }
  for (const [method, path, expected] of [['HEAD', '/sign-in', 200], ['GET', '/api/owner/invitations', 401]]) {
    const url = new URL(path, config.vars.DRIVE_ORIGIN);
    if (path === '/sign-in') url.searchParams.set('qerith_probe', randomBytes(16).toString('hex'));
    const response = await worker.dispatchFetch(url, { method, redirect: 'manual' });
    await response.body?.cancel();
    if (response.status !== expected) {
      throw new Error(`${method} ${path} returned ${response.status}; expected ${expected}`);
    }
  }
} finally {
  await worker.dispose();
}
