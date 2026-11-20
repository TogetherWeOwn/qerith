import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const rootFiles = ['root-listed-320.png', ...[390, 1280].flatMap(width => [
  ...['signed-out', 'empty', 'listed', 'invalid-page', 'exhausted', 'unavailable'].flatMap(state =>
    [`root-${state}-${width}.png`, `axe-root-${state}-${width}.json`]),
  `root-greyscale-${width}.png`, `root-forced-colours-focus-${width}.png`, `root-keyboard-${width}.json`,
])];

export async function verifyEvidence(dir, tested, root = false, upload = false, staging = false, folder = false) {
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
  await verifyEvidence(dir, tested, root, process.env.UPLOAD_EVIDENCE === 'true', process.env.STAGING_EVIDENCE === 'true', folder);
  const generated = root ? 'generated sign-in and My Drive (disposable D1)' : 'generated sign-in (disposable D1)';
  await writeFile(join(dir, 'provenance.json'), JSON.stringify({ requestedHead, testedCheckout: tested,
    base: base || null, snapshotBase: snapshotBase || null, integrationSnapshot: snapshot, mode, workflow, runId, runAttempt,
    runUrl: `${server}/${repository}/actions/runs/${runId}`,
    coverage: tested === requestedHead ? `synthetic fixture; ${generated}${folder ? '; generated staging-origin SSR folder (opt-in, disposable D1)' : ''}` : 'synthetic fixture only; not product behavior or sign-in' }, null, 2) + '\n');
}
