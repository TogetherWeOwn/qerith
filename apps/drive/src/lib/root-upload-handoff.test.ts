import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { partBytes } from './multipart-upload-plan';
import { resumeBoundMultipartToRoot, uploadBoundMultipartToRoot, type UploadResumeCandidate } from './root-upload';

test('a lost part acknowledgement stops the upload; re-picking uses the retained intent and trusted prefix', async () => {
  const intentId = '87654321-dddd-eeee-ffff-123456789000';
  const entryId = '12345678-aaaa-bbbb-cccc-123456789000';
  const path = `/api/uploads/${intentId}`;
  const prefix = new Uint8Array(partBytes);
  const file = new File([prefix, '!'], 'upload.txt');
  const sha256 = createHash('sha256').update(prefix).digest('hex');
  const calls: string[] = [];
  const progress: number[] = [];
  let candidate: UploadResumeCandidate | undefined;
  let expectedPartSha256s: string;
  const fetcher: typeof fetch = async (input, init) => {
    calls.push(`${init?.method} ${input}`);
    switch (calls.length) {
      case 1:
        expectedPartSha256s = JSON.parse(String(init?.body)).expectedPartSha256s;
        assert.equal(expectedPartSha256s, sha256 + createHash('sha256').update('!').digest('hex'));
        return Response.json({ id: intentId }, { status: 201 });
      case 2:
        assert.equal(candidate, intentId);
        throw new Error('The first part was committed, but the reply was lost');
      case 3:
        return Response.json({ declaredSize: file.size, expectedPartSha256s, parts: [{ partNumber: 1, sizeBytes: partBytes, sha256 }] });
      case 4:
        assert.equal(await (init?.body as Blob).text(), '!');
        return new Response(null, { status: 204 });
      case 5:
        return Response.json({ id: entryId }, { status: 201 });
      default:
        throw new Error('unexpected request');
    }
  };
  const accept = (bytes: number) => { progress.push(bytes); };

  assert.deepEqual(await uploadBoundMultipartToRoot(file, accept, id => { candidate = id; }, fetcher), { status: 'interrupted' });
  assert.deepEqual(calls, ['POST /api/uploads', `PUT ${path}/parts/1`]);
  assert.deepEqual(progress, []);
  assert.ok(candidate);
  const repicked = new File([file], file.name, { lastModified: file.lastModified + 1 });
  assert.deepEqual(await resumeBoundMultipartToRoot(candidate, repicked, accept, fetcher), { status: 'published', id: entryId });
  assert.deepEqual(calls.slice(2), [`GET ${path}/resume`, `PUT ${path}/parts/2`, `POST ${path}/complete`]);
  assert.deepEqual(progress, [partBytes, file.size]);
});
