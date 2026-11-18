import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Only the real route, app document and library enter this projection. In
// particular, don't load the source Vite config, Worker, hooks or other routes.
const source = resolve(process.argv[2], 'apps/drive');
const output = resolve(process.argv[3]);
const route = 'src/routes/f/[folderId]';
await mkdir(output);
for (const path of ['package.json', 'package-lock.json', '.npmrc', 'src/app.html', 'src/lib', route]) {
  await cp(join(source, path), join(output, path), { recursive: true });
}
const path = join(output, route, '+page.server.ts');
const loader = await readFile(path, 'utf8');
const call = 'folderPage(request, params.folderId)';
assert.equal(loader.split(call).length, 2, 'Expected exactly one unbound folderPage call');
await writeFile(path, `import { synthetic } from '../../../lib/ci-synthetic';\n${loader.replace(call, 'folderPage(request, params.folderId, synthetic)')}`);
await cp(new URL('./synthetic.ts', import.meta.url), join(output, 'src/lib/ci-synthetic.ts'), { force: false, errorOnExist: true });
await writeFile(join(output, 'vite.config.js'), `import { sveltekit } from '@sveltejs/kit/vite';\nexport default { plugins: [sveltekit()] };\n`);
