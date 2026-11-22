import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'svelte/compiler';

// Each entry permits one existing element. Native progress/output need no
// exemption. Modal and field feedback must stay in the active context.
const allowed = {
  'src/routes/+layout.svelte': [
    '<div role="status" aria-live="polite" aria-atomic="true"',
    '<div aria-live="assertive" aria-atomic="true"',
  ],
  'src/lib/MoveDialog.svelte': ['<p class="notice" role="alert" tabindex="-1" bind:this={notice} dir="auto"'],
  'src/lib/NameDialog.svelte': [
    '<p class="status" role="status"',
    '<p class="notice" role="alert" tabindex="-1" bind:this={notice}',
    '<span id={`${id}-error`} role="alert" dir="auto"',
  ],
  'src/lib/OwnerInviteDialog.svelte': [
    '<p class="status" role="status" aria-live="polite"',
    '<p class="notice" role="alert"', '<p role="alert"',
  ],
  'src/lib/ShareDialog.svelte': [
    '<p role="alert"', '<p class="notice" role="alert" tabindex="-1" bind:this={notice}',
    '<p class:sr={!status} role="status"',
  ],
  'src/lib/ShareRecipientPicker.svelte': [
    "<div role={onPageFeedback ? undefined : 'status'} class:popover={noMatch} class:message={noMatch} class:visually-hidden={!noMatch}",
  ],
  // Ratchet the existing document and route-specific regions.
  'src/routes/+page.svelte': ['<div role="alert"'],
  'src/routes/shared/+page.svelte': ['<p role="alert"'],
  'src/routes/f/[folderId]/+page.svelte': ['<p role="status" class:status={receipt === undefined}', '<p role="status"'],
  'src/lib/FileList.svelte': ['<p class="status" role="status"', '<p class="paging-error" role="alert"'],
  'src/lib/InviteAcceptance.svelte': [
    '<p class:sr-only={!!view} role="status" aria-live="polite" aria-atomic="true"',
    '<p id="invite-name-error" class="error" role="alert"', '<p class="notice info" role="alert"',
  ],
  'src/lib/SignInCard.svelte': [
    '<p class:notice={state === \'unsupported\'} class:warn={state === \'unsupported\'} class:sr-only={state === \'revoked\'} role="status" aria-live="polite"',
    '<p class="notice info" role="alert"',
  ],
};

const liveRoles = new Set(['alert', 'status', 'log']);
const liveAttributes = new Set(['aria-live', 'role']);
const markup = new Set(['RegularElement', 'SvelteElement', 'Component', 'SvelteComponent', 'SvelteSelf']);

function isLiveValue(name, value) {
  if (!liveAttributes.has(name)) return false;
  // A dynamic role or live priority cannot be established at lint time.
  if (typeof value !== 'string') return true;
  const tokens = value.trim().toLowerCase().split(/\s+/);
  return name === 'role' ? tokens.some(token => liveRoles.has(token)) : tokens[0] !== 'off';
}

function isLiveAttribute(attribute) {
  if (attribute.type === 'SpreadAttribute' && attribute.expression.type === 'ObjectExpression') {
    return attribute.expression.properties.some(({ type, key, computed, value }) => {
      if (type !== 'Property') return false;
      const name = key.type === 'Literal' ? key.value : !computed && key.name;
      return isLiveValue(name, value.type === 'Literal' ? value.value : undefined);
    });
  }
  if (attribute.type !== 'Attribute' || !liveAttributes.has(attribute.name)) return false;
  const { name, value } = attribute;
  const text = Array.isArray(value) && value.every(part => part.type === 'Text') ? value.map(part => part.data).join('') : undefined;
  return isLiveValue(name, text);
}

export function lintAnnouncements(path, source) {
  path = path.replaceAll('\\', '/');
  const exceptions = new Set(allowed[path] ?? []);
  const messages = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (markup.has(node.type) && node.attributes.some(isLiveAttribute)) {
      const signature = source.slice(node.start, node.attributes.at(-1).end);
      if (!exceptions.delete(signature)) {
        const line = source.slice(0, node.start).split('\n').length;
        messages.push(`${path}:${line}: use the layout announce() API for live feedback`);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (['attributes', 'expression', 'metadata'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  }
  visit(parse(source, { modern: true }).fragment);
  return messages;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const drive = fileURLToPath(new URL('../', import.meta.url));
  const paths = [...globSync('src/**/*.svelte', { cwd: drive }), 'src/app.html'];
  const messages = paths.flatMap(path => lintAnnouncements(path, readFileSync(resolve(drive, path), 'utf8')));
  if (messages.length) { console.error(messages.join('\n')); process.exitCode = 1; }
}
