import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadRoutes } from '../src/lib/server/upload-routes';

const origin = 'https://drive.example.test';
const path = '/api/uploads/00000000-0000-4000-8000-000000000001/resume';
const unreachable = () => assert.fail('Invalid resume request reached D1');
const DB = { prepare: unreachable, batch: unreachable, withSession: unreachable };
const { resume } = uploadRoutes({ DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1', DB });

test('rejects body framing and any query before accessing D1', async () => {
  for (const request of [
    new Request(origin + path, { headers: { 'content-length': '1' } }),
    new Request(origin + path, { headers: { 'transfer-encoding': 'chunked' } }),
    new Request(`${origin}${path}?`),
  ]) {
    const response = await resume(request);
    assert.ok(response);
    assert.deepEqual([response.status, response.headers.get('cache-control'), await response.text()],
      [400, 'private, no-store', '']);
  }
});

test('does not admit encoded IDs or enable resume outside the fixture', async () => {
  assert.equal(resume(new Request(origin + path.replace('00000000', '%300000000'))), undefined);
  const disabled = uploadRoutes({ DRIVE_ORIGIN: origin, DB });
  assert.equal((await disabled.resume(new Request(origin + path)))?.status, 404);
});
