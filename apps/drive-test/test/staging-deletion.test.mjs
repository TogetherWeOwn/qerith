import { afterEach, expect, it, vi } from 'vitest';
import { stagingOrigin } from '../../drive/src/lib/server/qualification-readiness.ts';
import { dispatchStagingDeletion } from '../../drive/src/lib/server/staging-deletion.ts';
import { bindings, job, qualification, removal, sentRequest, snapshot } from './fixtures/staging-deletion.mjs';
import { config, sessions, sql } from './fixtures/upload-completion.mjs';
import { seedBoundPublication } from './fixtures/upload-publication-generation.mjs';

const enabled = { ...bindings, DRIVE_STAGING_DELETE_REQUESTS: '1', DRIVE_STAGING_INVITE_ACCEPTANCE: '1' };
const canonical = '{"confirm":"permanent-delete"}';
const path = (id) => `/api/entries/${id}/delete`;
const request = ({ id, token }, { suffix = '', method = 'POST', body = canonical, headers = {} } = {}) =>
  new Request(stagingOrigin + path(id) + suffix, {
    method, body: method === 'POST' ? body : undefined,
    headers: { origin: stagingOrigin, cookie: `__Host-drive-session=${token}`, 'content-type': 'application/json',
      'content-length': String(body.length), ...headers }
  });

afterEach(() => vi.unstubAllGlobals());

it('leaves entries, usage, journals and storage untouched unless exact staging admission succeeds', async () => {
  const file = await seedBoundPublication('staging-denied');
  const other = await seedBoundPublication('other-owner');
  const before = await snapshot();
  const fetch = vi.fn(async () => removal());
  vi.stubGlobal('fetch', fetch);
  const probe = { ...enabled, DRIVE_S3_QUALIFICATION: JSON.stringify({ version: 1,
    storageConfigId: qualification.storageConfigId, region: qualification.region, sourceSha: 'a'.repeat(40),
    runId: '1', runAttempt: 1, completionTimeoutMs: 5000 }) };
  for (const [env, rule, status, options, target = file] of [
    [bindings, qualification, 404], [probe, undefined, 404],
    [{ ...enabled, DRIVE_ORIGIN: 'https://drive.example.test' }, qualification, 404],
    [{ ...enabled, DRIVE_SIGN_IN_FIXTURE: '1' }, qualification, 404],
    [{ ...enabled, DRIVE_QUALIFICATION_EXPIRES_AT: '1' }, qualification, 404],
    [{ ...enabled, DRIVE_S3_STORAGE_EPOCH: 'other-epoch' }, qualification, 503],
    [{ ...enabled, DRIVE_S3_REGION: 'other' }, qualification, 503],
    [enabled, { ...qualification, confirmsRemoval: undefined }, 503],
    [enabled, qualification, undefined, { suffix: '?' }],
    [enabled, qualification, undefined, { suffix: '/' }],
    [{ ...enabled, DRIVE_STAGING_INVITE_ACCEPTANCE: undefined }, qualification, 403],
    [enabled, qualification, 405, { method: 'GET' }],
    [enabled, qualification, 400, {}, { ...file, id: 'not-a-uuid' }],
    [enabled, qualification, 403, { headers: { origin: 'https://other.example.test' } }],
    [enabled, qualification, 403, { headers: { 'sec-fetch-site': 'cross-site' } }],
    [enabled, qualification, 400, { body: '{"confirm":"permanent-delete","confirm":"no"}' }],
    [enabled, qualification, 404, {}, { ...file, token: other.token }],
  ]) {
    const response = await dispatchStagingDeletion(request(target, options), env, rule);
    expect(response?.status).toBe(status);
    expect(await snapshot()).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  }
  await sessions.revoke(file.token);
  expect((await dispatchStagingDeletion(request(file), enabled, qualification)).status).toBe(401);
  expect(await snapshot()).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([['ambiguous', false], ['confirmed', true]])('journals the whole tree before dispatch with %s removal evidence', async (scenario, proven) => {
  const file = await seedBoundPublication(`staging-${scenario}`);
  const owner = await sql('SELECT owner_id FROM drive_entries WHERE id = ?', file.id).first('owner_id');
  const folder = crypto.randomUUID();
  await sql("INSERT INTO drive_entries (id, owner_id, name, kind) VALUES (?, ?, 'folder', 'folder')", folder, owner).run();
  await sql('UPDATE drive_entries SET parent_id = ? WHERE id = ?', folder, file.id).run();
  let lease;
  const fetch = vi.fn(async () => {
    const { results } = await sql('SELECT entry_id, deletion_id FROM drive_deleted_entries WHERE owner_id = ?', owner).all();
    // Capture evidence in the mock result; transport catches thrown assertions.
    expect(results.map(row => row.entry_id).sort()).toEqual([folder, file.id].sort());
    expect(new Set(results.map(row => row.deletion_id)).size).toBe(1);
    expect(await sql('SELECT count(*) AS n FROM drive_entries WHERE owner_id = ?', owner).first('n')).toBe(0);
    lease = (await job(file.id)).lease_token;
    expect(lease).toBeTruthy();
    return removal(proven);
  });
  vi.stubGlobal('fetch', fetch);

  const response = await dispatchStagingDeletion(request({ ...file, id: folder }), enabled, qualification);
  expect([response.status, response.headers.get('cache-control'), await response.text()]).toEqual([202, 'private, no-store', '']);
  expect(fetch.mock.settledResults).toEqual([{ type: 'fulfilled', value: expect.any(Response) }]);
  expect(fetch.mock.calls.map(([req]) => sentRequest(req))).toEqual([['DELETE', `${config.endpoint}/${config.bucket}/${file.key}`, true]]);
  const settled = await job(file.id);
  expect(settled).toMatchObject({ completion_token: proven ? lease : null, lease_token: null });
  if (proven) expect(settled.completed_at).toBeGreaterThan(0);
  else expect(settled.completed_at).toBeNull();
});
