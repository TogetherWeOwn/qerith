import { deepStrictEqual as equal } from 'node:assert/strict';

const space = /[ \t\r\n\f]*/y;
const gap = /(?:[ \t\r\n\f]+|<!--(?:\[(?:!|-?\d+)?|\]|\$s\d+)?-->)/y;
const scope = 'svelte-[a-z0-9]+';
const id = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const label = '[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}';
const asset = String.raw`\.\./_app/immutable/`;
const moduleLink = new RegExp(`<link href="(${asset}(?:entry|chunks|nodes)/[\\w.-]+\\.js)" rel="modulepreload">`, 'y');
const stylesheet = new RegExp(`<link href="${asset}assets/[\\w.-]+\\.css" rel="stylesheet">`, 'y');
const glyph = new RegExp(`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="${scope}">`, 'y');

const dialogOpen = /<dialog class="drive-dialog" aria-labelledby="s\d+-title" closedby="closerequest">/y;
const dialogTag = /<(div|form|header|footer|section|h2|h3|bdi|p|button|svg|path|label|input)((?: (?:class|id|type|role|autocomplete|tabindex|aria-(?:busy|hidden|label|disabled|invalid|labelledby)|for|value|dir|viewBox|fill|stroke(?:-width|-linecap)?|d)="[^"<>&]*")*)(\/?)>/y;
const dialogText = /[^<]+/y;
const dialogChildren = {
  dialog: ['div', 'form'], div: ['header', 'section', 'footer', 'button', 'dialog', 'div', 'label', 'input'],
  form: ['header', 'p', 'div', 'footer'], header: ['h2', 'button'], section: ['h3', 'button'],
  footer: ['button', 'div'], h2: ['bdi'], h3: ['bdi'], button: ['svg', 'bdi'], svg: ['path'],
};
const boot = new RegExp(String.raw`^\{
(__sveltekit_[a-z0-9]+) = \{
base: new URL\("\.\.", location\)\.pathname\.slice\(0, -1\),
version: "[0-9]+"
\};
const element = document\.currentScript\.parentElement;
import\("(${asset}entry/start\.[\w-]+\.js)"\)\.then\(async \(kit\) => \{
kit\.init\(\1\);
const app = await import\("(${asset}entry/app\.[\w-]+\.js)"\);
kit\.start\(app, element, \{
node_ids: \[0, ([1-9][0-9]*)\],
data: ([^\n<]+),
form: null,
error: null
\}\);
\}\);
\}$`);

// The emitted folder has no own ID in its SSR data. The caller binds it to
// the canonical response URL before checking the visible and hydration data.
export function verifyOwnedFolder(body, folder, children, ownerId) {
  const html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  let offset = 0;
  const fail = () => { throw new Error('Invalid owned folder document.'); };
  const read = pattern => {
    pattern.lastIndex = offset;
    const match = pattern.exec(html);
    if (match) offset = pattern.lastIndex;
    return match;
  };
  const skip = () => { while (read(gap)) { /* Svelte markers only at element boundaries. */ } };
  const literal = value => {
    if (!html.startsWith(value, offset)) fail();
    offset += value.length;
  };
  const tag = value => { skip(); literal(value); };
  const expect = pattern => read(pattern) ?? fail();

  // Only the two closed Move dialogs can precede the status. Restrict their
  // elements, attributes and nesting so nothing in them can escape into SSR.
  const dialogs = () => {
    skip();
    expect(dialogOpen);
    const stack = ['dialog'];
    let nested = false;
    while (stack.length) {
      skip();
      const parent = stack.at(-1);
      if (html.startsWith('</', offset)) {
        literal(`</${stack.pop()}>`);
      } else if (parent === 'div' && !nested && read(dialogOpen)) {
        nested = true;
        stack.push('dialog');
      } else if (['h2', 'h3', 'bdi', 'button', 'label'].includes(parent) && read(dialogText)) {
        continue;
      } else {
        const [, child, attrs, slash] = expect(dialogTag);
        const names = [...attrs.matchAll(/ ([\w-]+)="/g)].map(match => match[1]);
        if (!dialogChildren[parent]?.includes(child) || new Set(names).size !== names.length ||
            (slash && child !== 'input')) fail();
        if (child !== 'input') stack.push(child);
      }
    }
    if (!nested) fail();
  };

  if (/[\x00-\x08\x0b\x0e-\x1f\x7f]/.test(html)) fail();
  literal('<!doctype html>');
  read(space); literal('<html lang="en">');
  read(space); literal('<head>');
  read(space); literal('<meta charset="utf-8" />');
  read(space); literal('<meta name="viewport" content="width=device-width, initial-scale=1" />');
  const modules = new Set();
  read(space);
  for (let link; (link = read(moduleLink)); read(space)) modules.add(link[1]);
  expect(/<!--[0-9a-z]{1,7}--><!---->/y);
  literal(`<title>${folder.name} · Drive</title>`);
  read(space);
  expect(stylesheet);
  read(space);
  while (read(stylesheet)) read(space);
  literal('</head>');
  read(space); literal('<body>');
  read(space); literal('<div style="display: contents">');
  skip();
  const [, pageScope] = expect(new RegExp(`<main data-sveltekit-reload="" class="(${scope})">`, 'y'));
  tag(`<h1 dir="auto" tabindex="-1" class="${pageScope}">${folder.name}</h1>`);
  dialogs();
  tag(`<div class="${pageScope}">`);
  tag(`<p role="status" class="${pageScope} status">`);
  tag('</p>');
  tag('</div>');

  const rows = [];
  if (!children.length) {
    skip();
    const [, emptyScope] = expect(new RegExp(`<section class="empty (${scope})" aria-labelledby="empty-title">`, 'y'));
    tag('<div>');
    tag(`<h2 id="empty-title" class="${emptyScope}">This folder is empty.</h2>`);
    tag('</div>');
    tag('</section>');
  } else {
    tag(`<ul role="list" class="${pageScope}">`);
    const rowStart = new RegExp(`<li data-row="(${id})" class="${pageScope}">`, 'y');
    const link = new RegExp(`<a href="/f/(${id})" dir="auto" data-name="" class="${pageScope}">(${label})</a>`, 'y');
    for (const _ of children) {
      skip();
      const [, rowId] = expect(rowStart);
      skip(); expect(glyph);
      tag('<path d="M3 19V5h6l2 2h10v12H3Z"></path>');
      tag('</svg>');
      skip();
      const [, linkId, name] = expect(link);
      equal(linkId, rowId);
      rows.push({ id: rowId, name });
      tag(`<span class="kind ${pageScope}">Folder</span>`);
      tag('</li>');
    }
    tag('</ul>');
  }
  equal(rows.map(row => [row.id, row.name]).sort(), children.map(row => [row.id, row.name]).sort());
  tag('</main>');
  tag('<script>');
  const [, script] = expect(/([^<]+)<\/script>/y);
  const match = boot.exec(script.split('\n').map(line => line.trim()).filter(Boolean).join('\n'));
  if (!match || !modules.has(match[2]) || !modules.has(match[3])) fail();
  const [, , , , nodeId, data] = match;
  if (![...modules].some(path => path.startsWith(`../_app/immutable/nodes/${nodeId}.`))) fail();
  // Compare the pinned serializer's literal shape without evaluating it.
  // This also catches stale hydration, even when the visible listing agrees.
  const payload = (share, driveOwner) => {
    const entries = rows.map(row => `{id:"${row.id}",name:"${row.name}",kind:"folder",movable:true${share ? ',shareable:true' : ''}}`);
    const shareOwner = share ? `{recipientId:"${ownerId}",driveOwner:${driveOwner}}` : 'void 0';
    return `[null,{type:"data",data:{result:{status:"ok",folder:{name:"${folder.name}",entries:[${entries.join(',')}],nextPage:null,paged:false,canMove:true}},ownerInvites:${driveOwner},shareOwner:${shareOwner}},uses:{params:["folderId"]}}]`;
  };
  if (![payload(false, true), payload(false, false), ...(rows.length ? [payload(true, true), payload(true, false)] : [])].includes(data)) fail();
  read(space); literal('</div>');
  read(space); literal('</body>');
  read(space); literal('</html>');
  read(space);
  equal(offset, html.length);
}
