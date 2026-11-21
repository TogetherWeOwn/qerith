import assert from 'node:assert/strict';
import test from 'node:test';
import { stagingOrigin } from '../src/lib/server/qualification-readiness';
import { deletionDrainCron, dispatchStagingDeletion, resolveWorkerDeletionQualification,
  runStagingDeletionDrain, type WorkerDeletionCapability } from '../src/lib/server/staging-deletion';

const url = `${stagingOrigin}/api/entries/00000000-0000-4000-8000-000000000000/delete`;
const enabled = { DRIVE_ORIGIN: stagingOrigin, DRIVE_STAGING_DELETE_REQUESTS: '1' };
const qualification = { storageConfigId: 'fixture', region: 'auto', confirmsRemoval: () => false };
const request = (target = url, method = 'POST') => new Request(target, { method, headers: { origin: stagingOrigin } });

test('exact staging deletion is closed without explicit request admission and a rule', async () => {
  const defaultResponse = await dispatchStagingDeletion(request(), enabled);
  assert.equal(defaultResponse?.status, 404);
  assert.equal(defaultResponse?.headers.get('cache-control'), 'private, no-store');
  assert.equal((await dispatchStagingDeletion(request(), { DRIVE_ORIGIN: stagingOrigin }, qualification))?.status, 404);
  // The qualified request reaches the deletion handler, which has no DB here.
  assert.equal((await dispatchStagingDeletion(request(), enabled, qualification))?.status, 503);
});

test('staging deletion does not dispatch aliases', () => {
  for (const alias of [url + '?', url + '/', url + '/x', url.replace('/delete', '/%64elete'),
    url.replace('/00000000', '/%300000000'), url.replace(stagingOrigin, 'https://drive.example.test')]) {
    assert.equal(dispatchStagingDeletion(request(alias), enabled, qualification), undefined);
  }
});

test('only qualified staging deletion advertises the POST method', async () => {
  const closed = await dispatchStagingDeletion(request(url, 'GET'), enabled);
  assert.equal(closed?.status, 404);
  assert.equal(closed?.headers.get('allow'), null);
  const admitted = await dispatchStagingDeletion(request(url, 'GET'), enabled, qualification);
  assert.equal(admitted?.status, 405);
  assert.equal(admitted?.headers.get('allow'), 'POST');
});

test('scheduled admission is separate from HTTP admission and scoped to one trigger', async () => {
  const tick = { cron: deletionDrainCron };
  const scheduled = { DRIVE_ORIGIN: stagingOrigin, DRIVE_STAGING_DELETE_DRAIN: '1',
    get DB(): never { throw new Error('Denied ticks must not access D1'); } };
  assert.equal(await runStagingDeletionDrain(tick, enabled, qualification), 0);
  assert.equal(await runStagingDeletionDrain(tick, scheduled), 0);
  assert.equal(await runStagingDeletionDrain({ cron: '* * * * *' }, scheduled, qualification), 0);
  assert.equal((await dispatchStagingDeletion(request(), scheduled, qualification))?.status, 404);
});

test('the Worker resolves deletion only for its independently scoped capability', async () => {
  const expiresAt = String(Date.now() + 60_000);
  const storage = { DRIVE_S3_ENDPOINT: 'https://storage.example.test', DRIVE_S3_BUCKET: 'fixture',
    DRIVE_S3_REGION: 'auto', DRIVE_S3_STORAGE_EPOCH: 'test', DRIVE_S3_ACCESS_KEY_ID: 'fixture',
    DRIVE_S3_SECRET_ACCESS_KEY: 'fixture' };
  const capability: WorkerDeletionCapability = { ...qualification, sourceSha: 'a'.repeat(40),
    workerVersion: '00000000-0000-4000-8000-000000000001', expiresAt,
    storageConfigId: '["https://storage.example.test","fixture","test"]' };
  const env = { ...enabled, ...storage, DRIVE_STAGING_DELETE_DRAIN: '1',
    DRIVE_QUALIFICATION_SHA: capability.sourceSha, DRIVE_QUALIFICATION_VERSION: { id: capability.workerVersion },
    DRIVE_QUALIFICATION_EXPIRES_AT: expiresAt };
  assert.equal(resolveWorkerDeletionQualification(env, capability), capability);
  const expired = '1000000000000';
  const cases = [
    [env, undefined],
    [{ ...enabled, ...storage }, capability],
    [{ ...env, DRIVE_SIGN_IN_FIXTURE: '1' }, capability],
    [{ ...env, DRIVE_S3_REGION: 'us-east-1' }, capability],
    [{ ...env, DRIVE_S3_BUCKET: 'different' }, capability],
    [{ ...env, DRIVE_QUALIFICATION_EXPIRES_AT: String(Number(expiresAt) + 1) }, capability],
    [{ ...env, DRIVE_QUALIFICATION_EXPIRES_AT: expired }, { ...capability, expiresAt: expired }],
  ] as const;
  for (const [bindings, rule] of cases) {
    const denied = { ...bindings, get DB(): never { throw new Error('Denied admission must not access D1'); } };
    const resolved = resolveWorkerDeletionQualification(denied, rule);
    assert.equal(resolved, undefined);
    assert.equal((await dispatchStagingDeletion(request(), denied, resolved))?.status, 404);
    assert.equal(await runStagingDeletionDrain({ cron: deletionDrainCron }, denied, resolved), 0);
  }
});
