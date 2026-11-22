import { globSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const helper = 'src/lib/server/bounded-io.ts';
const workerConfig = 'vite.config.js';
const bodyMethods = new Set(['getReader', 'arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);
const streamMethods = new Set(['pipeTo', 'pipeThrough', 'values']);

// These exact expressions may only be removed. Streaming, deletion leases and
// upload allocation have separate lifetimes that need their own migrations.
const existing = new Map([
  ['src/lib/server/metadata/private-object-deletion.ts', [
    'performance.now() + requestMs',
    "setTimeout(() => { controller.abort(); done('unconfirmed'); }, requestMs)",
  ]],
  ['src/lib/server/published-download.ts', [
    'body.getReader()', 'AbortSignal.timeout(streamBudget.totalMs)', 'AbortSignal.timeout(timeoutMs)',
  ]],
  ['src/lib/server/s3/objects.ts', ['body.getReader()']],
  ['src/lib/server/s3/transport.ts', [
    'response.body?.getReader()', 'response.body?.getReader()',
    'performance.now() + budget.idleMs',
  ]],
  ['src/lib/server/upload-intent.ts', [
    'performance.now() + timeoutMs', 'performance.now() + timeoutMs',
    'setTimeout(() => preflight.abort(), timeoutMs)',
  ]],
]);

function inScope(path) {
  return path !== helper && !/\.(?:test|spec|d)\.[cm]?[jt]s$/.test(path) && (
    /^src\/lib\/server\//.test(path) || /\.server\.[cm]?[jt]s$/.test(path) ||
    /^src\/(?:routes\/(?:.*\/)?\+server|worker)\.[cm]?[jt]s$/.test(path));
}

function member(node) {
  node = ts.skipParentheses(node);
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
}

function globalName(node) {
  node = ts.skipParentheses(node);
  if (ts.isIdentifier(node)) return node.text;
  if (node.expression && ts.isIdentifier(node.expression) && node.expression.text === 'globalThis') return member(node);
}

function methodOn(node, owner, name) {
  return member(node) === name && globalName(ts.skipParentheses(node).expression) === owner;
}

function abortsInline(node) {
  return (ts.isCallExpression(node) && ['abort', 'cancel'].includes(member(node.expression))) ||
    ts.forEachChild(node, child => abortsInline(child) || undefined);
}

function violation(node) {
  if (ts.isCallExpression(node)) {
    const target = ts.skipParentheses(node.expression);
    if (bodyMethods.has(member(target)) && !methodOn(target, 'Response', 'json')) return 'direct body read';
    if (streamMethods.has(member(target)) && member(target.expression) === 'body') return 'direct body read';
    if (methodOn(target, 'AbortSignal', 'timeout')) return 'direct I/O timeout';
    const callback = node.arguments[0];
    if (globalName(target) === 'setTimeout' && callback &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && abortsInline(callback.body)) {
      return 'timer that aborts or cancels I/O';
    }
  }
  if (ts.isForOfStatement(node) && node.awaitModifier && member(node.expression) === 'body') return 'direct body read';
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      [node.left, node.right].map(operand => ts.skipParentheses(operand))
        .some(operand => ts.isCallExpression(operand) && methodOn(operand.expression, 'performance', 'now'))) {
    return 'manual I/O deadline';
  }
}

function workerSource(config) {
  const templates = [];
  function visit(node) {
    if (ts.isCallExpression(node) && globalName(node.expression) === 'writeFileSync') {
      const [target, contents] = node.arguments;
      if (target && ts.isCallExpression(target) && globalName(target.expression) === 'resolve' &&
          target.arguments.some(arg => ts.isStringLiteralLike(arg) && arg.text === '_worker.js')) {
        templates.push(contents);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(config);
  const [template] = templates;
  if (templates.length !== 1 || !template) return;
  const { line } = config.getLineAndCharacterOfPosition(template.getStart(config));
  const padding = '\n'.repeat(line);
  if (ts.isNoSubstitutionTemplateLiteral(template)) return padding + template.text;
  if (!ts.isTemplateExpression(template)) return;

  // The build interpolates JSON values. Parse the surrounding executable code
  // without running the build, retaining source line numbers after each value.
  let text = padding + template.head.text;
  let position = template.head.end;
  for (const { expression, literal } of template.templateSpans) {
    if (!ts.isCallExpression(expression) || !methodOn(expression.expression, 'JSON', 'stringify')) return;
    const end = literal.getStart(config);
    text += 'null' + config.text.slice(position, end).replace(/[^\n]/g, '') + literal.text;
    position = literal.end;
  }
  return text;
}

// Deliberately syntactic. Common direct calls are covered, including bracket
// notation. Alias/data-flow analysis and the transport's fetch policy are separate.
export function lintSource(path, contents) {
  if (path !== workerConfig && !inScope(path)) return [];
  let source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
  if (path === workerConfig) {
    const worker = workerSource(source);
    if (worker === undefined) return [`${path}: unable to locate the generated Worker template for bounded I/O lint.`];
    source = ts.createSourceFile(path, worker, ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) return [`${path}: unable to parse the generated Worker template for bounded I/O lint.`];
  }
  const allowed = [...(existing.get(path) ?? [])];
  const errors = [];
  function visit(node) {
    const issue = violation(node);
    if (issue) {
      const grandfathered = allowed.indexOf(node.getText(source));
      if (grandfathered >= 0) allowed.splice(grandfathered, 1);
      else {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        errors.push(`${path}:${line + 1}: ${issue}. Use ${helper} (readBoundedBody or withIoDeadline).`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (allowed.length) errors.push(`${path}: remove ${allowed.length} unused bounded I/O allowance(s).`);
  return errors;
}

if (import.meta.main) {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const paths = new Set(globSync('src/**/*.{ts,mts,cts,js,mjs,cjs}', { cwd })
    .map(path => path.split(sep).join('/')).filter(inScope));
  if (!paths.has('src/worker.ts')) throw new Error('Drive server sources were not found');
  paths.add(workerConfig);
  const errors = [...paths].sort().flatMap(path => lintSource(path, readFileSync(join(cwd, path), 'utf8')));
  for (const path of existing.keys()) {
    if (!paths.has(path)) errors.push(`${path}: remove bounded I/O allowances for the deleted file.`);
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Bounded I/O lint passed for ${paths.size} Drive server files.`);
  }
}
