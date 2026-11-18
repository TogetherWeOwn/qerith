import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyLock } from '../scripts/verify-lock-age.mjs';

const [repo, destination, mode] = process.argv.slice(2);
const source = resolve(repo, 'apps/drive');
const output = resolve(destination);
const route = 'src/routes/f/[folderId]';
const selfCheck = mode === 'self-check';
for (const lock of [new URL('./package-lock.json', import.meta.url), join(source, 'package-lock.json')]) {
  await verifyLock(JSON.parse(await readFile(lock, 'utf8')), async (name) => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(10000), redirect: 'error'
    });
    if (!response.ok) throw new Error(`Cannot verify registry metadata for ${name}: ${response.status}`);
    return response.json();
  });
}
assert(!existsSync(join(source, 'npm-shrinkwrap.json')), 'Shrinkwrap is unsupported in the projection');
await mkdir(output);
// Copy no source hooks, Worker or executable build configuration.
for (const path of ['package.json', 'package-lock.json', 'src/app.html', ...selfCheck ? [] : ['src/lib', route]]) {
  await cp(join(source, path), join(output, path), { recursive: true });
}
await cp(new URL('./.npmrc', import.meta.url), join(output, '.npmrc'));
const page = join(output, route);
if (selfCheck) {
  await mkdir(page, { recursive: true });
  await writeFile(join(page, '+page.server.ts'), `export const load = ({params}) => ({ title: params.folderId === 'next' ? 'New document' : 'Route evidence self-check' });\n`);
  await writeFile(join(page, '+page.svelte'), `<script>export let data;</script><svelte:head><title>{data.title}</title></svelte:head><main data-sveltekit-reload><h1>{data.title}</h1><a href="/f/next">Next document</a></main>\n`);
} else {
  const path = join(page, '+page.server.ts');
  const loader = await readFile(path, 'utf8');
  const call = 'folderPage(request, params.folderId)';
  assert.equal(loader.split(call).length, 2, 'Expected exactly one unbound folderPage call');
  await writeFile(path, `import { synthetic } from '../../../lib/ci-synthetic';\n${loader.replace(call, 'folderPage(request, params.folderId, synthetic)')}`);
  await cp(new URL('./synthetic.ts', import.meta.url), join(output, 'src/lib/ci-synthetic.ts'), { force: false, errorOnExist: true });
}
await writeFile(join(output, 'vite.config.js'), `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n`);
