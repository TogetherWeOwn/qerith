import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import { verifyEvidence } from './browser-evidence.mjs';
import { selectCheckout } from './select-browser-checkout.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), snapshot = 'c'.repeat(40);
const input = { event: 'pull_request', head, base, snapshot };
function graph({ hasHead = false, hasSnapshot = true, introducedHead = false,
  introducedBase = true, onMain = true, parents = `${base} ${head}` } = {}) {
  return (...args) => {
    if (args[0] === 'show') return parents;
    if (args[0] === 'ls-tree') return (args[2] === head ? hasHead : hasSnapshot) ? 'fixture' : '';
    if (args[0] === 'is-ancestor') return args[2] === 'origin/main' ? onMain : args[2] === head ? introducedHead : introducedBase;
    throw new Error('Unexpected git operation');
  };
}

async function writeBaseEvidence(dir) {
  await writeFile(join(dir, 'head.txt'), head);
  for (const size of ['1280x800', '390x844']) {
    await writeFile(join(dir, `${size}.png`), Buffer.from('89504e470d0a1a0a', 'hex'));
    await writeFile(join(dir, `axe-${size}.json`), '{"violations":[]}');
    await writeFile(join(dir, `keyboard-${size}.json`), '{"tab":true}');
  }
}

function viewportPng(width, height) {
  const chunk = (type, data) => {
    const png = Buffer.alloc(data.length + 12);
    png.writeUInt32BE(data.length);
    png.write(type, 4);
    data.copy(png, 8);
    png.writeUInt32BE(crc32(png.subarray(4, -4)), png.length - 4);
    return png;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit greyscale, filter 0 on each row.
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

test('legacy fixture selects the bound integration snapshot', () => {
  assert.deepEqual(selectCheckout(input, graph()), { tested: snapshot, mode: 'legacy-integration-fixture', snapshotBase: base });
});
test('fixture-bearing head remains exact-head', () => {
  assert.deepEqual(selectCheckout(input, graph({ hasHead: true })), { tested: head, mode: 'head', snapshotBase: base });
});
test('deleted fixture after introduction and missing snapshot fail closed', () => {
  assert.throws(() => selectCheckout(input, graph({ introducedHead: true })), /not eligible/);
  assert.throws(() => selectCheckout(input, graph({ hasSnapshot: false })), /missing the fixture/);
  assert.throws(() => selectCheckout(input, graph({ introducedBase: false })), /not eligible/);
});
test('main can move after the event base was recorded', () => {
  const movedBase = 'd'.repeat(40);
  assert.deepEqual(selectCheckout(input, graph({ parents: `${movedBase} ${head}` })),
    { tested: snapshot, mode: 'legacy-integration-fixture', snapshotBase: movedBase });
});
test('wrong parent count, head, main ancestry and mutable refs fail closed', () => {
  for (const parents of [`${head} ${base}`, `${base} ${'d'.repeat(40)}`, base, `${base} ${head} ${snapshot}`]) {
    assert.throws(() => selectCheckout(input, graph({ parents })), /does not bind/);
  }
  assert.throws(() => selectCheckout(input, graph({ onMain: false })), /does not bind/);
  assert.throws(() => selectCheckout(input, (...args) => {
    if (args[0] === 'is-ancestor') throw new Error('missing main ref');
    return graph()(...args);
  }), /missing main ref/);
  assert.throws(() => selectCheckout({ ...input, head: 'main' }, graph()), /immutable/);
  assert.throws(() => selectCheckout({ ...input, event: 'push' }, graph()), /must match/);
});
test('generated browser entrypoints have separate exact-head deadlines', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split(/^  drive-browser:\n/m)[1]?.split(/^  \S/m)[0];
  assert.ok(job, 'drive-browser job is missing');
  const steps = job.split(/^      - /m).slice(1);
  const deadline = 'timeout --signal=TERM --kill-after=10s 90s node ';
  const exactHead = 'steps.browser-source.outputs.tested == env.REQUESTED_HEAD';
  const entrypoints = [['sign-in.mjs', exactHead], ['staging-root-standalone.mjs',
    `${exactHead} && hashFiles('tested/apps/drive/browser/staging-root-standalone.mjs') != ''`]];
  const [signInStep, stagingStep] = entrypoints.map(([entry, condition]) => {
    const matches = steps.filter(step => step.includes(deadline + entry));
    assert.equal(matches.length, 1, `${entry} must have one bounded invocation`);
    assert.ok(matches[0].split('\n').includes(`        if: ${condition}`), `${entry} has the wrong CI condition`);
    return matches[0];
  });
  assert.notEqual(signInStep, stagingStep, 'the fixtures must run in separate steps');
  const browser = new URL('../apps/drive/browser/', import.meta.url);
  assert.match(await readFile(new URL('staging-root-standalone.mjs', browser), 'utf8'), /^import '\.\/staging-root\.mjs';$/m);
  assert.doesNotMatch(await readFile(new URL('sign-in.mjs', browser), 'utf8'), /staging-root.*\.mjs/);
});

test('evidence fails when missing, empty or bound to the wrong checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-evidence-test-'));
  try {
    await assert.rejects(verifyEvidence(dir, head));
    await writeBaseEvidence(dir);
    await verifyEvidence(dir, head);
    const verifyShare = () => verifyEvidence(dir, head, false, false, false, false, false, false, false, true);
    await assert.rejects(verifyShare(), /share-recipient-390-keyboard\.json/);
    const verifyContinuation = () => verifyEvidence(dir, head, false, false, false, false, true);
    await assert.rejects(verifyContinuation(), /root-continuation-390\.json/);
    const proofPath390 = join(dir, 'root-continuation-390.json');
    await writeFile(proofPath390, '{}');
    await assert.rejects(verifyContinuation(), /Invalid continuation trace: 390/);
    const intent = '/api/uploads/00000000-0000-4000-8000-000000000101';
    const fresh = '/api/uploads/00000000-0000-4000-8000-000000000103';
    const resume = ['GET', `${intent}/resume`, null];
    const destination = '{"parentId":null,"name":"Re-picked.txt"}';
    const finished = (...parts) => {
      const requests = [resume, ...parts, ['POST', `${intent}/complete`, destination]];
      return { pending: { requests }, published: { requests } };
    };
    const evidenceOnly = { requests: [resume] };
    const continuation = { canceled: { requests: [] }, suffix: { pending: evidenceOnly, refused: evidenceOnly },
      acknowledged: finished(), empty: finished(['PUT', `${intent}/parts/1`, 0]), 'empty-acknowledged': finished(),
      fresh: { requests: [['POST', '/api/uploads', '{"size":16777217}'], ['PUT', `${fresh}/parts/1`, 16777216],
        ['PUT', `${fresh}/parts/2`, 1], ['POST', `${fresh}/complete`, destination]] } };
    const verifyDeletion = () => verifyEvidence(dir, head, false, false, false, false, false, false, true);
    await assert.rejects(verifyDeletion(), /delete-file-390-keyboard\.json/);
    const deleteStages = ['open', 'saving', 'error', 'accepted'];
    const writes = [[1, 400], [1, 401], [1, 403], [1, 404], [1, 200], [1, 0], [1, 503], [1, 202], [3, 202], [2, 202]]
      .map(([id, status]) => ['POST', `/api/entries/00000000-0000-4000-8000-00000000000${id}/delete`,
        'application/json', '{"confirm":"permanent-delete"}', status]);
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      await writeFile(join(dir, `root-continuation-${width}.json`), JSON.stringify(continuation));
      await writeFile(join(dir, `axe-root-continuation-${width}.json`), '{"violations":[]}');
      const pngAt = w => viewportPng(w, height);
      const png = pngAt(width);
      const shareStates = ['empty', 'options', 'picked', 'already-selected', 'no-match'];
      for (const w of width === 390 ? [width, 320] : [width]) {
        await writeFile(join(dir, `share-recipient-${w}-keyboard.json`), JSON.stringify(Object.fromEntries(shareStates.map(state => [state, '- main']))));
        for (const state of shareStates) await writeFile(join(dir, `axe-share-recipient-${w}-${state}.json`), '{"violations":[]}');
        for (const state of [...shareStates, 'greyscale', 'forced-colours']) await writeFile(join(dir, `share-recipient-${w}-${state}.png`), pngAt(w));
      }
      for (const label of ['acknowledged-finishing', 'empty-finishing', 'empty-acknowledged-finishing', 'suffix-interrupted', 'uploaded']) {
        await writeFile(join(dir, `root-continuation-${label}-${width}.png`), png);
      }
      const deletionPath = join(dir, `delete-file-${width}-keyboard.json`);
      const error = 'We couldn’t confirm the deletion request. Check My Drive before trying again.';
      const captures = {
        open: { focus: 'Cancel', tree: '- dialog "Delete “Receipts.pdf”?":\n  - button "Cancel"' },
        saving: { focus: 'Deleting…', tree: '- dialog "Delete “Receipts.pdf”?":\n  - status: Deleting…' },
        error: { focus: error, tree: `- dialog "Delete “Receipts.pdf”?":\n  - alert: ${error}` },
        accepted: { focus: 'Statement.pdf', tree: '- main:\n  - status: Deletion request accepted for “Receipts.pdf”.' },
      };
      const deletion = { width, height, writes, captures };
      await writeFile(deletionPath, JSON.stringify(deletion));
      for (const stage of deleteStages) {
        await writeFile(join(dir, `delete-file-${width}-${stage}.png`), png);
        await writeFile(join(dir, `axe-delete-file-${width}-${stage}.json`), '{"violations":[]}');
      }
      for (const mode of ['greyscale', 'forced-colours']) await writeFile(join(dir, `delete-file-${width}-${mode}.png`), png);
      if (width === 390) await writeFile(join(dir, 'delete-file-320-reflow.png'), pngAt(320));
      if (width === 1280) {
        await verifyDeletion();
        const reflow = join(dir, 'delete-file-320-reflow.png');
        const reflowImage = await readFile(reflow);
        await writeFile(reflow, png);
        await assert.rejects(verifyDeletion(), /Invalid deletion screenshot: delete-file-320-reflow/);
        await writeFile(reflow, reflowImage);
        await writeFile(deletionPath, JSON.stringify({ ...deletion, writes: writes.slice(1) }));
        await assert.rejects(verifyDeletion(), /Invalid deletion trace: 1280/);
        for (const accepted of [{ ...captures.accepted, focus: 'Cancel' }, { ...captures.accepted, tree: '- button' }]) {
          await writeFile(deletionPath, JSON.stringify({ ...deletion, captures: { ...captures, accepted } }));
          await assert.rejects(verifyDeletion(), /Invalid deletion evidence: delete-file-1280-accepted/);
        }
        await writeFile(deletionPath, JSON.stringify(deletion));
        const axePath = join(dir, 'axe-delete-file-1280-saving.json');
        await writeFile(axePath, '{"violations":[{}]}');
        await assert.rejects(verifyDeletion(), /Invalid deletion evidence: delete-file-1280-saving/);
        await writeFile(axePath, '{"violations":[]}');
        const screenshot = join(dir, 'root-continuation-uploaded-1280.png');
        const headerOnly = Buffer.concat([png.subarray(0, 33), png.subarray(-12)]);
        const wrongHeight = Buffer.from(png), overrun = Buffer.from(png);
        wrongHeight.writeUInt32BE(844, 20);
        overrun.writeUInt32BE(png.length, 33); // IDAT claims more bytes than the file contains.
        const malformedType = Buffer.from(png);
        malformedType[37] |= 0x80; // Set the high bit on the I in IDAT, leaving the payload intact.
        malformedType.writeUInt32BE(crc32(malformedType.subarray(37, -16)), malformedType.length - 16);
        for (const invalid of [headerOnly, wrongHeight, overrun, malformedType]) {
          await writeFile(screenshot, invalid);
          await assert.rejects(verifyContinuation(), /Invalid continuation screenshot: uploaded-1280/);
        }
        await writeFile(screenshot, png);
      }
    }
    await verifyShare();
    await writeFile(join(dir, 'axe-share-recipient-320-already-selected.json'), '{"violations":[{}]}');
    await assert.rejects(verifyShare(), /Invalid picker evidence: share-recipient-320-already-selected/);
    await verifyContinuation();
    for (const requests of [[], continuation.fresh.requests.map(([method, path, body]) => [method, path.replace(fresh, intent), body]),
      continuation.fresh.requests.map(([method, path, body]) => [method, path, method === 'PUT' ? 0 : body])]) {
      await writeFile(proofPath390, JSON.stringify({ ...continuation, fresh: { requests } }));
      await assert.rejects(verifyContinuation(), /Invalid continuation trace: 390/);
    }
    const verifyFolder = () => verifyEvidence(dir, head, false, false, false, true);
    await assert.rejects(verifyFolder(), /staging-folder-keyboard-390/);
    await writeFile(join(dir, 'staging-folder-keyboard-390.json'), JSON.stringify({ viewport: [390, 844], visibleTabFocus: true,
      enterDocumentNavigation: ['Child folder', 'Go to My Drive', 'Next page', 'First page'] }));
    await assert.rejects(verifyFolder(), /staging-folder-listed-390.png/);
    const folderLabel = 'staging-folder-listed-390';
    const folderPng = Buffer.alloc(64);
    Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(folderPng);
    folderPng.writeUInt32BE(390, 16);
    folderPng.writeUInt32BE(844, 20);
    await writeFile(join(dir, `${folderLabel}.png`), folderPng);
    await writeFile(join(dir, `${folderLabel}-tree.txt`), 'Child folder');
    await writeFile(join(dir, `axe-${folderLabel}.json`), '{"violations":[]}');
    await assert.rejects(verifyFolder(), { message: `Invalid folder evidence: ${folderLabel}` });
    Buffer.from('0000000049454e44ae426082', 'hex').copy(folderPng, folderPng.length - 12);
    await writeFile(join(dir, `${folderLabel}.png`), folderPng);
    await assert.rejects(verifyFolder(), /staging-folder-empty-390.png/);
    const stagingPath = join(dir, 'staging-root-round-trip.json');
    await assert.rejects(verifyEvidence(dir, head, false, false, true), /staging-root-round-trip\.json/);
    const staging = { mode: 'staging-origin', signIn: 'passkey', picker: 'Tab then Enter', navigations: 0,
      refresh: { method: 'GET', path: '/__data.json', status: 200 }, fullDownload: { bytes: 6, byteIdentical: true },
      rangeDownload: { status: 206, contentRange: 'bytes 1-3/6', byteIdentical: true },
      denied: { signedOut: 401, member: 403, revoked: 401, wrongOrigin: 403, crossSite: 403, unlisted: 404 } };
    await writeFile(stagingPath, JSON.stringify({ ...staging, navigations: 1 }));
    await assert.rejects(verifyEvidence(dir, head, false, false, true), /Invalid staging evidence/);
    await writeFile(stagingPath, JSON.stringify(staging));
    await verifyEvidence(dir, head, false, false, true);
    await assert.rejects(verifyEvidence(dir, head, true), { code: 'ENOENT' });
    await assert.rejects(verifyEvidence(dir, head, false, true), /root-upload-round-trip\.json/);
    const proof = { byteIdentical: true, bytes: 8193, statusRegions: 1, documentsDuringRefresh: 0, focusPreserved: true,
      refresh503PreservedUpload: true, keyboard: 'Tab then Enter opened the single-file picker', sha256: '0'.repeat(64),
      responses: [['POST', 201], ['PUT', 204], ['POST', 201], ['GET', 200], ['POST', 201], ['PUT', 204], ['POST', 409], ['POST', 201], ['PUT', 204], ['POST', 201], ['GET', 503]] };
    const proofPath = join(dir, 'root-upload-round-trip.json');
    await writeFile(proofPath, JSON.stringify(proof));
    await assert.rejects(verifyEvidence(dir, head, false, true), { message: 'Invalid upload evidence' });
    proof.sha256 = '2d18045cc77c707b09f9b436b44e5b90923bfdee7b80fec763479b0e1ef88c0a';
    await writeFile(proofPath, JSON.stringify(proof));
    await writeFile(join(dir, 'root-uploading-390.png'), Buffer.from('89504e470d0a1a0a0000000d4948445200000500000003200802000000000000000000000049454e44ae426082', 'hex'));
    await writeFile(join(dir, 'axe-root-uploading-390.json'), '{"violations":[]}');
    await assert.rejects(verifyEvidence(dir, head, false, true), { message: 'Invalid upload evidence: root-uploading-390' });
    await assert.rejects(verifyEvidence(dir, base), /does not match/);
    await writeFile(join(dir, 'axe-1280x800.json'), '{"violations":[{}]}');
    await assert.rejects(verifyEvidence(dir, head), /Invalid axe/);
    await writeFile(join(dir, 'axe-1280x800.json'), '{"violations":[]}');
    await writeFile(join(dir, 'keyboard-1280x800.json'), '{}');
    await assert.rejects(verifyEvidence(dir, head), /Invalid axe/);
    await writeFile(join(dir, 'keyboard-1280x800.json'), '{"tab":true}');
    await writeFile(join(dir, '390x844.png'), '');
    await assert.rejects(verifyEvidence(dir, head), /Empty evidence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('routed Share gates bind to the exact head and require each fixture’s evidence', async t => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const step = workflow.split('      - name: Verify evidence and record both provenance identities\n')[1]?.split(/^      - /m)[0];
  assert.ok(step);
  const run = promisify(execFile);
  const script = fileURLToPath(new URL('./browser-evidence.mjs', import.meta.url));
  const fixtures = [
    ['root', 'ROOT_SHARE_EVIDENCE', ['signed-out', 'root', 'invite-empty', 'dialog'], [
      '- dialog "Share “Shareable file”":',
      '    - option "Root Reader"',
      '  - button "Remove Root Reader’s access": Remove',
      '  - button "Invite someone"',
      '- main:',
      '  - heading "Users and invites" [level=1]',
    ]],
    ['nested', 'NESTED_SHARE_EVIDENCE', ['signed-out', 'owner', 'menu', 'inherited', 'confirm', 'revoked', 'read-only', 'invite-empty'], [
      '- menu:',
      '  - menuitem "Share"',
      '  - menuitem "Move"',
      '- dialog "Share “Review materials”":',
      '    - option "New Reader"',
      '  - text: Through Shared project Can view',
      '  - button "Confirm removal of direct access for Folder Reader"',
      '  - status: Removed direct access for Folder Reader.',
      '  - button "Invite someone"',
      '- main:',
      '  - heading "Users and invites" [level=1]',
    ]],
  ];
  for (const [scope, flag, states, review] of fixtures) {
    await t.test(scope, async () => {
      const stem = `${scope}-share`;
      const gate = `steps.browser-source.outputs.tested == env.REQUESTED_HEAD && hashFiles('tested/apps/drive/browser/${stem}.mjs') != ''`;
      assert.ok(step.split('\n').includes('          ' + flag + ': ${{ ' + gate + ' }}'));
      const dir = await mkdtemp(join(tmpdir(), `browser-${stem}-test-`));
      const env = { EVIDENCE_DIR: dir, TESTED_SHA: head, REQUESTED_HEAD: head, SNAPSHOT_SHA: snapshot,
        COMPATIBILITY_MODE: 'head', GITHUB_WORKFLOW: 'CI', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1',
        GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'example/fixture' };
      const verify = (enabled = 'true') => run(process.execPath, [script], { env: { ...env, [flag]: enabled } });
      const detail = (mode, width, height) => scope === 'root'
        ? `${stem}-${width}x${height}-${mode}` : `${stem}-${mode}-${width}`;
      try {
        await writeBaseEvidence(dir);
        await verify('false');
        await assert.rejects(verify(), { stderr: new RegExp(`ENOENT.*${stem}-signed-out-390\\.png`) });
        for (const [width, height] of [[390, 844], [1280, 800]]) {
          const png = viewportPng(width, height);
          for (const state of states) {
            const label = `${stem}-${state}-${width}`;
            const screenshot = state === 'signed-out' ? viewportPng(width, height + 16) : png;
            await writeFile(join(dir, `${label}.png`), screenshot);
            await writeFile(join(dir, `axe-${label}.json`), '{"violations":[]}');
          }
          for (const mode of ['greyscale', 'forced-colours']) {
            await writeFile(join(dir, `${detail(mode, width, height)}.png`), png);
          }
          await writeFile(join(dir, `${detail('reflow', width, height)}.png`), viewportPng(320, height));
          await writeFile(join(dir, `${detail('aria-review', width, height)}.txt`), [...review,
            '  - heading "People with access" [level=3]',
            '  - combobox "Add people" [expanded]',
            '  - listbox "Available people":',
          ].join('\n'));
        }
        await verify();
        const missing = join(dir, `${detail('forced-colours', 1280, 800)}.png`);
        const original = await readFile(missing);
        await rm(missing);
        await assert.rejects(verify(), { stderr: new RegExp(`ENOENT.*${detail('forced-colours', 1280, 800)}\\.png`) });
        await writeFile(missing, original);
        const mobilePng = viewportPng(390, 844);
        const headerOnly = Buffer.concat([mobilePng.subarray(0, 33), mobilePng.subarray(-12)]);
        const ariaReview = `${detail('aria-review', 1280, 800)}.txt`;
        const originalReview = await readFile(join(dir, ariaReview), 'utf8');
        const invalid = [
          [`${stem}-${states.at(-1)}-390.png`, headerOnly, 'screenshot'],
          [`axe-${stem}-${states.at(-1)}-1280.json`, '{"violations":[{}]}', 'axe evidence'],
          [`${detail('greyscale', 390, 844)}.png`, viewportPng(390, 845), 'screenshot'],
          [`${detail('reflow', 1280, 800)}.png`, viewportPng(1280, 800), 'screenshot'],
          [ariaReview, originalReview.replace('  - heading "Users and invites" [level=1]', ''), 'ARIA review'],
        ];
        for (const [file, content, kind] of invalid) {
          const path = join(dir, file);
          const good = await readFile(path);
          await writeFile(path, content);
          const label = file.slice(0, file.lastIndexOf('.')).replace(/^axe-/, '');
          await assert.rejects(verify(), { stderr: new RegExp(`Invalid Share ${kind}: ${label}`) });
          await writeFile(path, good);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
