import assert from 'node:assert/strict';
import test from 'node:test';
import { stagingOrigin } from '../src/lib/server/qualification-readiness';
import { dispatchStagingDeletion } from '../src/lib/server/staging-deletion';

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
