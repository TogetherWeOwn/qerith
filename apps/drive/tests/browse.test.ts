import assert from 'node:assert/strict';
import test from 'node:test';
import { browseFolder } from '../src/lib/server/browse';

const request = new Request('https://example.test/f/private');

test('does not read a folder when authorization is absent or fails', async () => {
  for (const authorize of [async () => null, async () => { throw new Error('auth failed'); }]) {
    let reads = 0;
    const result = await browseFolder(request, 'private', {
      authorize,
      readFolder: async () => { reads++; return { name: 'secret' }; }
    });
    assert.deepEqual(result, { status: 'unavailable' });
    assert.equal(reads, 0);
  }
});

test('does not disclose missing folders or storage failures', async () => {
  for (const readFolder of [async () => null, async () => { throw new Error('secret'); }]) {
    const result = await browseFolder(request, 'private', {
      authorize: async () => ({ subject: 'member' }),
      readFolder
    });
    assert.deepEqual(result, { status: 'unavailable' });
  }
});

test('passes the authorized capability to the folder reader', async () => {
  const capability = { subject: 'member' };
  const result = await browseFolder(request, null, {
    authorize: async (receivedRequest, folderId) => {
      assert.equal(receivedRequest, request);
      assert.equal(folderId, null);
      return capability;
    },
    readFolder: async (access, folderId) => {
      assert.equal(access, capability);
      assert.equal(folderId, null);
      return { name: 'My Drive' };
    }
  });
  assert.deepEqual(result, { status: 'ok', folder: { name: 'My Drive' } });
});
