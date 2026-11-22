import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { stagingRoutes } from '../src/lib/server/staging-routes';

const endpointFile = /^\+server\.[jt]s$/;
const pageModule = /^\+page(?:@[\w-]*)?(?:\.server)?\.[jt]s$/;
const pageComponent = /^\+page(?:@.*)?\.svelte$/;
const httpMethods = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']);

async function assertRouteCoverage(root: string, declarations: typeof stagingRoutes) {
  const files = (await readdir(root, { withFileTypes: true, recursive: true })).filter(file => file.isFile());
  const modules = files.filter(file => endpointFile.test(file.name) || pageModule.test(file.name))
    .map(file => join(file.parentPath, file.name));
  const program = ts.createProgram(modules, { allowJs: true, noResolve: true, noLib: true, types: [] });
  const checker = program.getTypeChecker();
  const actual = new Set<string>();
  for (const file of files) {
    const endpoint = endpointFile.test(file.name);
    const component = pageComponent.test(file.name);
    if (!endpoint && !component && !pageModule.test(file.name)) continue;
    const id = '/' + relative(root, file.parentPath).split(sep).join('/');
    const key = `${endpoint ? 'endpoint' : 'page'} ${id}`;
    if (!endpoint) {
      actual.add(`GET ${key}`);
      actual.add(`HEAD ${key}`);
    }
    if (component) continue;
    const path = join(file.parentPath, file.name);
    const source = program.getSourceFile(path);
    const symbol = source && checker.getSymbolAtLocation(source);
    assert.ok(symbol, `Route module has no exports: ${relative(root, path)}`);
    const exports = checker.getExportsOfModule(symbol).map(member => member.name);
    if (endpoint) {
      const methods = exports.filter(name => httpMethods.has(name));
      assert.ok(methods.length, `Route module has no explicit HTTP methods: ${relative(root, path)}`);
      for (const method of methods) actual.add(`${method} ${key}`);
    } else if (exports.includes('actions')) {
      actual.add(`POST ${key}`);
    }
  }

  const declared = new Set<string>();
  for (const route of declarations) {
    if (route.source === 'worker') continue;
    for (const method of route.methods) {
      const key = `${method} ${route.source} ${route.path}`;
      assert.ok(!declared.has(key), `Duplicate staging route declaration: ${key}`);
      declared.add(key);
    }
  }
  const missing = [...actual].filter(route => !declared.has(route)).sort();
  const stale = [...declared].filter(route => !actual.has(route)).sort();
  assert.deepEqual({ missing, stale }, { missing: [], stale: [] },
    'Every file-based route method needs an admission or explicit exclusion declaration');
}

test('every file-based Drive route method has a staging declaration', async () => {
  await assertRouteCoverage(fileURLToPath(new URL('../src/routes', import.meta.url)), stagingRoutes);
});

test('a new file-based route without a declaration fails coverage', async () => {
  await using fixture = await mkdtempDisposable(join(tmpdir(), 'drive-route-coverage-'));
  const endpoint = join(fixture.path, 'api', 'example', '+server.ts');
  await mkdir(dirname(endpoint), { recursive: true });
  await writeFile(endpoint, 'export const GET = () => new Response();\n');
  await assert.rejects(assertRouteCoverage(fixture.path, []), /GET endpoint \/api\/example/);
});
