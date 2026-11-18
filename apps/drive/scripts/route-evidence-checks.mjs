import assert from 'node:assert/strict';

const groups = ['dependencies', 'devDependencies'];
const lockedFields = ['name', 'version', ...groups];
const manifestFields = [...lockedFields, 'private', 'type', 'scripts'];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function isExactVersion(version) {
  if (typeof version !== 'string' || version.length > 256 || version !== version.trim()) return false;
  // Canonical SemVer without build metadata, which this projection does not support.
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  return match !== null && match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part))) &&
    !(match[4]?.split('.').some((part) => /^0\d+$/.test(part)));
}

export function verifyManifest(manifest, lock) {
  const root = lock?.packages?.[''];
  assert(lock?.lockfileVersion === 3 && isRecord(lock.packages) && isRecord(root) && isRecord(manifest) &&
    typeof root.name === 'string' && root.name &&
    (root.version === undefined || (typeof root.version === 'string' && root.version)) &&
    Object.keys(root).every((key) => lockedFields.includes(key)) &&
    Object.keys(manifest).every((key) => manifestFields.includes(key)),
    'Unsupported projection manifest or lock root');
  for (const key of lockedFields) assert.deepEqual(manifest[key], root[key], `Manifest/lock drift: ${key}`);
  for (const group of groups) {
    const specs = manifest[group];
    if (specs === undefined) continue;
    assert(isRecord(specs), `Expected a dependency map: ${group}`);
    for (const [name, version] of Object.entries(specs)) {
      const entry = lock.packages[`node_modules/${name}`];
      assert(name.length <= 214 && name === name.trim() &&
        /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/.test(name) &&
        isExactVersion(version) && entry?.version === version, `Expected a locked exact registry version: ${name}`);
      // This is the direct preflight. verify-lock-age still checks the full graph and registry metadata.
      const tarball = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`;
      // SHA-512 is 64 bytes; only two bits of the last Base64 character may be nonzero.
      assert(!entry.link && entry.resolved === tarball && typeof entry.integrity === 'string' &&
        entry.integrity.length === 95 && /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/.test(entry.integrity),
        `Expected registry source and integrity: ${name}`);
    }
  }
}

export const normalizeSpeech = (phrases) => phrases.join(' ').replace(/\s+/g, ' ').trim();

// Compares HTTP evidence only. Callers must independently assert unavailable page identity.
export async function unavailableResponse(response) {
  assert(response && !response.request().redirectedFrom(), 'Expected a direct unavailable document response');
  const status = response.status();
  // The synthetic route renders the generic state as a normal page, not an error response.
  assert.equal(status, 200, 'Expected the generic unavailable document status');
  const fields = await response.headersArray();
  const allHeaders = Object.create(null);
  for (const { name, value } of fields) (allHeaders[name.toLowerCase()] ??= []).push(value);
  const [contentType, ...duplicates] = allHeaders['content-type'] ?? [];
  // Drive declares UTF-8 in its template when SvelteKit sends bare text/html.
  assert(!duplicates.length && /^text\/html(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?$/i.test(contentType?.trim()),
    'Expected one unavailable UTF-8 HTML document content type');
  const body = await response.body();
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  assert.doesNotMatch(text, /[\0\x1b]/, 'Expected UTF-8 HTML without NUL or encoding escape bytes');
  for (const value of [text, ...fields.flatMap(({ name, value }) => [name, value])]) {
    assert.doesNotMatch(value, /Synthetic title that must not leak|Project records/, 'Unavailable document contains a private fixture marker');
  }
  // Date is ignored for equality, not for the marker scan. Compare body bytes, not decoded text.
  const { date, ...headers } = allHeaders;
  return { status, headers, body };
}
