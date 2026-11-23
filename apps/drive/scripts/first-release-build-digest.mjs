import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bundle = '.svelte-kit/first-release-package';
const assets = '.svelte-kit/cloudflare';

async function assetsManifest(root, directory = '') {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const manifest = [];
  for (const entry of entries) {
    const name = directory + entry.name;
    if (name === '_worker.js') continue;
    if (entry.isDirectory()) manifest.push(...await assetsManifest(root, name + '/'));
    else if (entry.isFile()) manifest.push([name, sha256(await readFile(resolve(root, name)))]);
    else throw new Error('Unexpected Drive asset type');
  }
  return manifest;
}

export async function firstReleaseBuildDigest() {
  const entries = await readdir(bundle);
  if (!entries.includes('_worker.js') ||
      entries.some(name => !['_worker.js', '_worker.js.map', 'README.md'].includes(name))) {
    throw new Error('Unexpected Drive bundle contents');
  }
  const worker = sha256(await readFile(resolve(bundle, '_worker.js')));
  const manifest = await assetsManifest(assets);
  if (!manifest.some(([name]) => name === '_app/version.json')) throw new Error('Drive assets are missing');
  manifest.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return sha256(JSON.stringify({ worker, assets: manifest }));
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? '')) {
  console.log(await firstReleaseBuildDigest());
}
