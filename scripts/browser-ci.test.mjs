import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
test('evidence fails when missing, empty or bound to the wrong checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-evidence-test-'));
  try {
    const files = ['head.txt', ...['1280x800', '390x844'].flatMap(size =>
      [`${size}.png`, `axe-${size}.json`, `keyboard-${size}.json`])];
    await assert.rejects(verifyEvidence(dir, head));
    for (const file of files) {
      const content = file === 'head.txt' ? head : file.endsWith('.png')
        ? Buffer.from('89504e470d0a1a0a', 'hex') : file.startsWith('axe-')
          ? '{"violations":[]}' : '{"tab":true}';
      await writeFile(join(dir, file), content);
    }
    await verifyEvidence(dir, head);
    const verifyContinuation = () => verifyEvidence(dir, head, false, false, false, false, true);
    await assert.rejects(verifyContinuation(), /root-continuation-390\.json/);
    const proofPath390 = join(dir, 'root-continuation-390.json');
    await writeFile(proofPath390, '{}');
    await assert.rejects(verifyContinuation(), /Invalid continuation trace: 390/);
    const phase = { requests: [] };
    const finished = { pending: phase, published: phase };
    const continuation = { canceled: phase, fresh: phase, suffix: { pending: phase, refused: phase },
      acknowledged: finished, empty: finished, 'empty-acknowledged': finished };
    for (const width of [390, 1280]) {
      await writeFile(join(dir, `root-continuation-${width}.json`), JSON.stringify(continuation));
      await writeFile(join(dir, `axe-root-continuation-${width}.json`), '{"violations":[]}');
      const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000000000003200802000000000000000000000049454e44ae426082', 'hex');
      png.writeUInt32BE(width, 16);
      for (const label of ['acknowledged-finishing', 'empty-finishing', 'empty-acknowledged-finishing', 'suffix-interrupted', 'uploaded']) {
        await writeFile(join(dir, `root-continuation-${label}-${width}.png`), png);
      }
    }
    await verifyContinuation();
    await writeFile(join(dir, 'root-continuation-uploaded-1280.png'), 'not a PNG');
    await assert.rejects(verifyContinuation(), /Invalid continuation screenshot: uploaded-1280/);
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
