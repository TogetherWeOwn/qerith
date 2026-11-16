import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));

test('Drive project configuration covers server source and rejects type errors', () => {
  const config = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.options.strict, true);
  assert.equal(parsed.options.noEmit, true);
  for (const source of ['src/worker.ts', 'src/lib/server/metadata/private.ts']) {
    assert.ok(parsed.fileNames.includes(`${root}${source}`), `${source} must be checked`);
  }

  const filename = `${root}src/worker.ts`;
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => name === filename
    ? ts.createSourceFile(name, 'const invalid: string = 42; export {};', ts.ScriptTarget.Latest)
    : getSourceFile(name, ...args);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  assert.ok(program.getSemanticDiagnostics().some((diagnostic) =>
    diagnostic.file?.fileName === filename && diagnostic.code === 2322));
});

test('application globals exclude Node while tooling remains checked', () => {
  const readConfig = (name) => {
    const config = ts.readConfigFile(`${root}${name}`, ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    assert.deepEqual(parsed.errors, []);
    return parsed;
  };
  const app = readConfig('tsconfig.json');
  const tooling = readConfig('tsconfig.tooling.json');
  const viteConfig = `${root}vite.config.js`;
  assert.ok(!app.fileNames.includes(viteConfig));
  assert.ok(tooling.fileNames.includes(viteConfig));

  const filename = `${root}src/worker.ts`;
  const host = ts.createCompilerHost(app.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => name === filename
    ? ts.createSourceFile(name, "export const invalid = Buffer.from('browser');", ts.ScriptTarget.Latest)
    : getSourceFile(name, ...args);
  const program = ts.createProgram(app.fileNames, app.options, host);
  assert.ok(program.getSemanticDiagnostics().some((diagnostic) =>
    diagnostic.file?.fileName === filename && diagnostic.code === 2591));
});
