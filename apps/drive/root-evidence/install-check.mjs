import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyManifest } from '../scripts/route-evidence-checks.mjs';
import { verifyLock } from '../scripts/verify-lock-age.mjs';

const dirs = process.argv.slice(2);
assert.equal(dirs.length, 2);
const releaseMetadata = new Map();
for (const dir of dirs) {
  assert(!existsSync(join(dir, 'npm-shrinkwrap.json')), 'Unexpected shrinkwrap');
  const [manifest, lock] = await Promise.all(['package.json', 'package-lock.json'].map(async name => JSON.parse(await readFile(join(dir, name), 'utf8'))));
  verifyManifest(manifest, lock);
  const count = await verifyLock(lock, async name => {
    if (!releaseMetadata.has(name)) {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
        signal: AbortSignal.timeout(10000), redirect: 'error',
      });
      if (!response.ok) throw new Error(`Cannot verify registry metadata for ${name}: ${response.status}`);
      releaseMetadata.set(name, await response.json());
    }
    return releaseMetadata.get(name);
  });
  console.log(`Verified release age and integrity for ${count} locked entries in ${dir}`);
}
