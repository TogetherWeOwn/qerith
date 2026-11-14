import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const registry = 'https://registry.npmjs.org/';
const minimumAgeMs = 3 * 24 * 60 * 60 * 1000;

export async function verifyLock(lock, getMetadata, now = Date.now()) {
  if (lock.lockfileVersion !== 3 || !lock.packages || !lock.packages['']) {
    throw new Error('Expected an npm v3 lockfile with a root package');
  }
  const entries = Object.entries(lock.packages).filter(([path]) => path !== '');
  if (!entries.length) throw new Error('Lockfile has no dependencies');
  const cache = new Map();
  for (const [path, entry] of entries) {
    const name = path.split('node_modules/').at(-1);
    if (!path.startsWith('node_modules/') || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/.test(name) ||
        typeof entry.version !== 'string' || typeof entry.integrity !== 'string') {
      throw new Error(`Invalid locked package: ${path}`);
    }
    const expected = `${registry}${name}/-/${name.split('/').at(-1)}-${entry.version}.tgz`;
    if (entry.resolved !== expected) throw new Error(`Unexpected package source: ${path}`);
    if (!cache.has(name)) cache.set(name, await getMetadata(name));
    const metadata = cache.get(name);
    const published = Date.parse(metadata.time?.[entry.version]);
    if (metadata.name !== name || !Number.isFinite(published) || published > now - minimumAgeMs ||
        metadata.versions?.[entry.version]?.dist?.integrity !== entry.integrity) {
      throw new Error(`Missing, too recent, or mismatched registry metadata: ${name}@${entry.version}`);
    }
  }
  return entries.length;
}

async function main() {
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const count = await verifyLock(lock, async (name) => {
    const response = await fetch(`${registry}${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(10000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`Registry metadata request failed: ${name} (${response.status})`);
    return response.json();
  });
  console.log(`Verified release age and integrity for ${count} locked entries`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
