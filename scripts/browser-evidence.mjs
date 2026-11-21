import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const rootFiles = ['root-listed-320.png', ...[390, 1280].flatMap(width => [
  ...['signed-out', 'empty', 'listed', 'invalid-page', 'exhausted', 'unavailable'].flatMap(state =>
    [`root-${state}-${width}.png`, `axe-root-${state}-${width}.json`]),
  `root-greyscale-${width}.png`, `root-forced-colours-focus-${width}.png`, `root-keyboard-${width}.json`,
])];

function hasViewportImageData(png, width, height) {
  if (png.length < 45 || !png.subarray(0, 16).equals(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')) ||
      png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) return false;
  let hasData = false;
  for (let offset = 33; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + length + 12;
    if (end > png.length) return false;
    const type = png.toString('latin1', offset + 4, offset + 8); // Preserve the high bit of each byte.
    if (type === 'IEND') return hasData && end === png.length &&
      png.subarray(offset).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
    if (type === 'IDAT' && length > 0) hasData = true;
    offset = end;
  }
  return false;
}

async function verifyDeletionEvidence(dir) {
  const writes = [[1, 400], [1, 401], [1, 403], [1, 404], [1, 200], [1, 0], [1, 503], [1, 202], [3, 202], [2, 202]]
    .map(([id, status]) => ['POST', `/api/entries/00000000-0000-4000-8000-00000000000${id}/delete`,
      'application/json', '{"confirm":"permanent-delete"}', status]);
  const uncertain = 'We couldn’t confirm the deletion request. Check My Drive before trying again.';
  const stages = {
    open: ['Cancel', 'button "Cancel"'], saving: ['Deleting…', 'status: Deleting…'],
    error: [uncertain, `alert: ${uncertain}`], accepted: ['Statement.pdf', 'status: Deletion request accepted for “Receipts.pdf”.'],
  };
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    const proof = JSON.parse(await readFile(join(dir, `delete-file-${width}-keyboard.json`), 'utf8'));
    if (proof?.width !== width || proof.height !== height || !isDeepStrictEqual(proof.writes, writes)) {
      throw new Error(`Invalid deletion trace: ${width}`);
    }
    for (const [stage, [focus, treeFragment]] of Object.entries(stages)) {
      const label = `delete-file-${width}-${stage}`;
      const png = await readFile(join(dir, `${label}.png`));
      const axe = JSON.parse(await readFile(join(dir, `axe-${label}.json`), 'utf8'));
      const capture = proof.captures?.[stage];
      if (!hasViewportImageData(png, width, height) || !Array.isArray(axe?.violations) || axe.violations.length ||
          capture?.focus !== focus || typeof capture.tree !== 'string' ||
          !capture.tree.split('\n').some(line => line.trim() === `- ${treeFragment}`)) {
        throw new Error(`Invalid deletion evidence: ${label}`);
      }
    }
    for (const [w, mode] of [[width, 'greyscale'], [width, 'forced-colours'], ...(width === 390 ? [[320, 'reflow']] : [])]) {
      const label = `delete-file-${w}-${mode}`;
      if (!hasViewportImageData(await readFile(join(dir, `${label}.png`)), w, height)) throw new Error(`Invalid deletion screenshot: ${label}`);
    }
  }
}

async function verifyShareRecipientEvidence(dir) {
  const states = ['empty', 'options', 'picked', 'already-selected', 'no-match'];
  for (const [width, height] of [[390, 844], [1280, 800], [320, 844]]) {
    const trace = JSON.parse(await readFile(join(dir, `share-recipient-${width}-keyboard.json`), 'utf8'));
    for (const state of states) {
      const label = `share-recipient-${width}-${state}`;
      const axe = JSON.parse(await readFile(join(dir, `axe-${label}.json`), 'utf8'));
      if (!Array.isArray(axe?.violations) || axe.violations.length || typeof trace?.[state] !== 'string' || !trace[state].trim()) {
        throw new Error(`Invalid picker evidence: ${label}`);
      }
    }
    for (const state of [...states, 'greyscale', 'forced-colours']) {
      const label = `share-recipient-${width}-${state}`;
      if (!hasViewportImageData(await readFile(join(dir, `${label}.png`)), width, height)) throw new Error(`Invalid picker screenshot: ${label}`);
    }
  }
}

export async function verifyEvidence(dir, tested, root = false, upload = false, staging = false, folder = false,
  continuation = false, shared = false, deletion = false, shareRecipient = false) {
  const names = ['head.txt', ...['1280x800', '390x844'].flatMap(size =>
    [`${size}.png`, `axe-${size}.json`, `keyboard-${size}.json`])];
  for (const name of root ? [...names, ...rootFiles] : names) {
    if (!(await stat(join(dir, name))).size) throw new Error(`Empty evidence: ${name}`);
  }
  if ((await readFile(join(dir, 'head.txt'), 'utf8')).trim() !== tested) {
    throw new Error('Evidence head does not match tested checkout');
  }
  if (upload) {
    const proof = JSON.parse(await readFile(join(dir, 'root-upload-round-trip.json'), 'utf8'));
    const responses = [['POST', 201], ['PUT', 204], ['POST', 201], ['GET', 200], ['POST', 201], ['PUT', 204],
      ['POST', 409], ['POST', 201], ['PUT', 204], ['POST', 201], ['GET', 503]];
    if (proof?.byteIdentical !== true || proof.bytes !== 8193 || proof.statusRegions !== 1 ||
        proof.documentsDuringRefresh !== 0 || proof.focusPreserved !== true || proof.refresh503PreservedUpload !== true ||
        proof.keyboard !== 'Tab then Enter opened the single-file picker' || JSON.stringify(proof.responses) !== JSON.stringify(responses) ||
        proof.sha256 !== '2d18045cc77c707b09f9b436b44e5b90923bfdee7b80fec763479b0e1ef88c0a') throw new Error('Invalid upload evidence');
    for (const width of [390, 1280]) for (const state of ['uploading', 'uploaded']) {
      const label = `root-${state}-${width}`;
      const screenshot = await readFile(join(dir, `${label}.png`));
      const axe = JSON.parse(await readFile(join(dir, `axe-${label}.json`), 'utf8'));
      if (!screenshot.subarray(0, 16).equals(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')) ||
          screenshot.length < 45 || screenshot.readUInt32BE(16) !== width || !screenshot.subarray(-8).equals(Buffer.from('49454e44ae426082', 'hex')) ||
          !Array.isArray(axe.violations) || axe.violations.length) throw new Error(`Invalid upload evidence: ${label}`);
    }
  }
  if (continuation) for (const [width, height] of [[390, 844], [1280, 800]]) {
    const proof = JSON.parse(await readFile(join(dir, `root-continuation-${width}.json`), 'utf8'));
    const requireTrace = (phase, expected) => {
      const actual = phase.split('.').reduce((value, key) => value?.[key], proof);
      if (!isDeepStrictEqual(actual?.requests, expected)) throw new Error(`Invalid continuation trace: ${width} ${phase}`);
    };
    const intent = '/api/uploads/00000000-0000-4000-8000-000000000101';
    const fresh = '/api/uploads/00000000-0000-4000-8000-000000000103';
    const resume = ['GET', `${intent}/resume`, null];
    const destination = '{"parentId":null,"name":"Re-picked.txt"}';
    requireTrace('canceled', []);
    requireTrace('fresh', [['POST', '/api/uploads', '{"size":16777217}'], ['PUT', `${fresh}/parts/1`, 16777216],
      ['PUT', `${fresh}/parts/2`, 1], ['POST', `${fresh}/complete`, destination]]);
    for (const phase of ['pending', 'refused']) requireTrace(`suffix.${phase}`, [resume]);
    const finishing = ['acknowledged', 'empty', 'empty-acknowledged'];
    for (const label of finishing) {
      const expected = [resume, ...(label === 'empty' ? [['PUT', `${intent}/parts/1`, 0]] : []),
        ['POST', `${intent}/complete`, destination]];
      for (const phase of ['pending', 'published']) requireTrace(`${label}.${phase}`, expected);
    }
    const axe = JSON.parse(await readFile(join(dir, `axe-root-continuation-${width}.json`), 'utf8'));
    if (!Array.isArray(axe?.violations) || axe.violations.length) throw new Error(`Invalid continuation axe evidence: ${width}`);
    for (const state of [...finishing.map(label => `${label}-finishing`), 'suffix-interrupted', 'uploaded']) {
      const label = `${state}-${width}`;
      const png = await readFile(join(dir, `root-continuation-${label}.png`));
      if (!hasViewportImageData(png, width, height)) throw new Error(`Invalid continuation screenshot: ${label}`);
    }
  }
  if (staging) {
    const proof = JSON.parse(await readFile(join(dir, 'staging-root-round-trip.json'), 'utf8'));
    const denied = { signedOut: 401, member: 403, revoked: 401, wrongOrigin: 403, crossSite: 403, unlisted: 404 };
    if (proof?.mode !== 'staging-origin' || proof.signIn !== 'passkey' || proof.picker !== 'Tab then Enter' || proof.navigations !== 0 ||
        proof.refresh?.method !== 'GET' || proof.refresh.path !== '/__data.json' || proof.refresh.status !== 200 ||
        proof.fullDownload?.bytes !== 6 || proof.fullDownload.byteIdentical !== true || proof.rangeDownload?.status !== 206 ||
        proof.rangeDownload.contentRange !== 'bytes 1-3/6' || proof.rangeDownload.byteIdentical !== true ||
        Object.entries(denied).some(([key, status]) => proof.denied?.[key] !== status)) throw new Error('Invalid staging evidence');
  }
  if (folder) for (const [width, height] of [[390, 844], [1280, 800]]) {
    const keyboard = JSON.parse(await readFile(join(dir, `staging-folder-keyboard-${width}.json`), 'utf8'));
    const links = ['Child folder', 'Go to My Drive', 'Next page', 'First page'];
    if (keyboard?.viewport?.[0] !== width || keyboard?.viewport?.[1] !== height || keyboard.visibleTabFocus !== true ||
        JSON.stringify(keyboard.enterDocumentNavigation) !== JSON.stringify(links)) throw new Error(`Invalid folder keyboard evidence: ${width}`);
    for (const state of ['listed', 'empty', 'denied', 'missing', 'continued', 'end']) {
      const label = `staging-folder-${state}-${width}`;
      const png = await readFile(join(dir, `${label}.png`));
      const tree = await readFile(join(dir, `${label}-tree.txt`), 'utf8');
      const axe = JSON.parse(await readFile(join(dir, `axe-${label}.json`), 'utf8'));
      if (!png.subarray(0, 16).equals(Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')) ||
          png.length < 45 || png.readUInt32BE(16) !== width ||
          !png.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex')) || !tree.trim() ||
          !Array.isArray(axe.violations) || axe.violations.length) throw new Error(`Invalid folder evidence: ${label}`);
    }
  }
  if (deletion) await verifyDeletionEvidence(dir);
  if (shareRecipient) await verifyShareRecipientEvidence(dir);
  if (shared) for (const [width, height] of [[390, 844], [1280, 800]]) {
    const keyboard = JSON.parse(await readFile(join(dir, `staging-shared-keyboard-${width}.json`), 'utf8'));
    if (!isDeepStrictEqual(keyboard, { viewport: [width, height], visibleFocus: true, skipToMain: true, keyboardDownload: true }))
      throw new Error(`Invalid shared keyboard evidence: ${width}`);
    for (const state of ['empty', 'listed']) {
      const label = `staging-shared-${state}-${width}`;
      const png = await readFile(join(dir, `${label}.png`));
      const axe = JSON.parse(await readFile(join(dir, `axe-${label}.json`), 'utf8'));
      if (!hasViewportImageData(png, width, height) || !Array.isArray(axe?.violations) || axe.violations.length)
        throw new Error(`Invalid shared evidence: ${label}`);
    }
  }
  for (const size of ['1280x800', '390x844']) {
    const png = await readFile(join(dir, `${size}.png`));
    if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      throw new Error(`Invalid screenshot: ${size}`);
    }
    const axe = JSON.parse(await readFile(join(dir, `axe-${size}.json`), 'utf8'));
    const keyboard = JSON.parse(await readFile(join(dir, `keyboard-${size}.json`), 'utf8'));
    if (!Array.isArray(axe.violations) || axe.violations.length || !keyboard ||
        Array.isArray(keyboard) || typeof keyboard !== 'object' || !Object.keys(keyboard).length) {
      throw new Error(`Invalid axe or keyboard evidence: ${size}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { EVIDENCE_DIR: dir, TESTED_SHA: tested, REQUESTED_HEAD: requestedHead,
    BASE_SHA: base, SNAPSHOT_SHA: snapshot, SNAPSHOT_BASE: snapshotBase, COMPATIBILITY_MODE: mode,
    GITHUB_WORKFLOW: workflow, GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: runAttempt,
    GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository } = process.env;
  if (![dir, tested, requestedHead, snapshot, mode, workflow, runId, runAttempt, server, repository].every(Boolean)) {
    throw new Error('Missing provenance context');
  }
  const root = process.env.ROOT_EVIDENCE === 'true';
  const folder = process.env.STAGING_FOLDER_EVIDENCE === 'true';
  await verifyEvidence(dir, tested, root, process.env.UPLOAD_EVIDENCE === 'true', process.env.STAGING_EVIDENCE === 'true',
    folder, process.env.CONTINUATION_EVIDENCE === 'true', process.env.STAGING_SHARED_EVIDENCE === 'true',
    process.env.DELETE_FILE_EVIDENCE === 'true', process.env.SHARE_RECIPIENT_EVIDENCE === 'true');
  const generated = root ? 'generated sign-in and My Drive (disposable D1)' : 'generated sign-in (disposable D1)';
  await writeFile(join(dir, 'provenance.json'), JSON.stringify({ requestedHead, testedCheckout: tested,
    base: base || null, snapshotBase: snapshotBase || null, integrationSnapshot: snapshot, mode, workflow, runId, runAttempt,
    runUrl: `${server}/${repository}/actions/runs/${runId}`,
    coverage: tested === requestedHead ? `synthetic fixture; ${generated}${folder ? '; generated staging-origin SSR folder (opt-in, disposable D1)' : ''}` : 'synthetic fixture only; not product behavior or sign-in' }, null, 2) + '\n');
}
