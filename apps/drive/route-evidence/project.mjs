import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLock } from '../scripts/verify-lock-age.mjs';
import { verifyManifest } from '../scripts/route-evidence-checks.mjs';

const [repo, output] = process.argv.slice(2);
const source = resolve(repo, 'apps/drive');
const route = 'src/routes/f/[folderId]';
const selfCheck = process.env.GITHUB_EVENT_NAME === 'pull_request';
const graphs = await Promise.all([fileURLToPath(new URL('.', import.meta.url)), source].map(async (dir) => {
  assert(!existsSync(join(dir, 'npm-shrinkwrap.json')), 'Shrinkwrap is unsupported in the projection');
  const [manifest, lock] = await Promise.all(['package.json', 'package-lock.json'].map(async name => JSON.parse(await readFile(join(dir, name), 'utf8'))));
  verifyManifest(manifest, lock);
  return { manifest, lock };
}));
for (const { lock } of graphs) await verifyLock(lock, async (name) => {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(10000), redirect: 'error'
  });
  if (!response.ok) throw new Error(`Cannot verify registry metadata for ${name}: ${response.status}`);
  return response.json();
});
await mkdir(output);
const { manifest, lock } = graphs[1];
for (const [name, data] of [['package.json', manifest], ['package-lock.json', lock]]) await writeFile(join(output, name), JSON.stringify(data));
// Copy no source hooks, Worker or executable build configuration.
for (const path of ['src/app.html', ...selfCheck ? [] : ['src/lib', route]]) {
  await cp(join(source, path), join(output, path), { recursive: true });
}
await cp(new URL('./.npmrc', import.meta.url), join(output, '.npmrc'));
const page = join(output, route);
if (selfCheck) {
  await mkdir(page, { recursive: true });
  await writeFile(join(page, '+page.server.ts'), `export const load = ({params}) => ({ title: params.folderId === 'next' ? 'New document' : 'Route evidence self-check' });\n`);
  await writeFile(join(page, '+page.svelte'), `<script>export let data;</script><svelte:head><title>{data.title} · Drive</title></svelte:head><main data-sveltekit-reload><h1>{data.title}</h1><a href="/f/next">New document</a></main>\n`);
} else {
  const path = join(page, '+page.server.ts');
  const loader = await readFile(path, 'utf8');
  const call = 'folderPage(request, params.folderId)';
  assert.equal(createHash('sha256').update(loader.replaceAll('\r\n', '\n')).digest('hex'),
    '701b4a085396080e4804696c608529c14936562425c7a388fe7374d56db42c35', 'Folder loader changed; review the projection seam');
  await writeFile(path, `import { synthetic } from '../../../lib/ci-synthetic';\n${loader.replace(call, 'folderPage(request, params.folderId, synthetic)')}`);
  await cp(new URL('./synthetic.ts', import.meta.url), join(output, 'src/lib/ci-synthetic.ts'), { force: false, errorOnExist: true });
}
await writeFile(join(output, 'vite.config.js'), `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n`);
