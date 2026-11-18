import assert from 'node:assert/strict';

const groups = ['dependencies', 'devDependencies'];
const lockedFields = ['name', 'version', ...groups];
const manifestFields = [...lockedFields, 'private', 'type', 'scripts'];

export function verifyManifest(manifest, lock) {
  const root = lock.packages?.[''];
  assert(root && Object.keys(root).every((key) => lockedFields.includes(key)) &&
    Object.keys(manifest).every((key) => manifestFields.includes(key)),
    'Unsupported projection manifest or lock root');
  for (const key of lockedFields) assert.deepEqual(manifest[key], root[key], `Manifest/lock drift: ${key}`);
  for (const group of groups) {
    for (const [name, version] of Object.entries(manifest[group] ?? {})) {
      assert(typeof version === 'string' && version === version.trim() &&
        /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) && lock.packages[`node_modules/${name}`]?.version === version,
        `Expected a locked exact registry version: ${name}`);
    }
  }
}

export const normalizeSpeech = (phrases) => phrases.join(' ').replace(/\s+/g, ' ').trim();

export async function unavailableResponse(response) {
  assert(response && !response.request().redirectedFrom(), 'Expected a direct unavailable document response');
  const { date, ...headers } = await response.allHeaders();
  const body = await response.text();
  assert.doesNotMatch(body, /Synthetic title that must not leak|Project records/, 'Unavailable document contains a private fixture marker');
  return { status: response.status(), headers, body };
}
