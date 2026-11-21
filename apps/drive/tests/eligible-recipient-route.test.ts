import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchEligibleRecipients, getEligibleRecipients } from '../src/lib/server/eligible-recipient-route';
import { eligibleRecipientsRoute, privateRequests, stagingOrigin } from '../src/lib/server/request-auth';
import { admitStagingRequest } from '../src/lib/server/staging-admission';

const origin = 'https://drive.example.test';
const path = '/api/entries/source/eligible-recipients';
const env = {
  DRIVE_ORIGIN: origin, DRIVE_SIGN_IN_FIXTURE: '1',
  DB: {
    prepare() { assert.fail('Unexpected SQL'); },
    withSession() { assert.fail('Unexpected D1 session'); },
  },
};
const ask = (url: string, init?: RequestInit) => getEligibleRecipients(new Request(origin + url, init), env, null);

async function expectDenial(response: Response, status: number) {
  assert.deepEqual([response.status, response.headers.get('cache-control'), response.headers.get('access-control-allow-origin'),
    await response.text()], [status, 'private, no-store', null, '']);
}

test('recipient lookup accepts only bodyless same-origin GET', async () => {
  for (const method of ['HEAD', 'POST', 'OPTIONS']) {
    const response = await ask(path, { method });
    await expectDenial(response, 405);
    assert.equal(response.headers.get('allow'), 'GET');
  }
  await expectDenial(await ask(path, { headers: { origin: 'https://other.example.test' } }), 403);
  await expectDenial(await ask(path, { headers: { 'sec-fetch-site': 'same-site' } }), 403);
  await expectDenial(await ask(path, { headers: { 'content-length': '1' } }), 400);
  await expectDenial(await ask(path, { headers: { 'content-length': '0', 'transfer-encoding': 'chunked' } }), 400);
  await expectDenial(await ask(path, { headers: { 'content-length': '0', origin, 'sec-fetch-site': 'same-origin' } }), 401);
});

test('recipient lookup rejects noncanonical paths and accepts one bounded opaque cursor', async () => {
  for (const url of [`${path}/`, `${path}?`, path.replace('source', '%73ource'), path.replace('source', 'a%2fb')]) {
    await expectDenial(await ask(url), 404);
  }
  for (const query of ['cursor=', 'cursor=a&cursor=b', 'cursor=%C0%AF', 'principal=source', `cursor=${'%C3%A9'.repeat(257)}`]) {
    await expectDenial(await ask(`${path}?${query}`), 400);
  }
  await expectDenial(await ask(`${path.replace('source', 'a%2Fb')}?cursor=%C3%A9%26%2B`), 401);
});

test('fixture dispatch rejects malformed queries and unsupported methods before the adapter', async () => {
  const unexpected = () => assert.fail('The adapter must not receive invalid requests');
  for (const url of [`${path}?x-sveltekit-test=1`, `${path}?cursor=a&cursor=b`]) {
    const response = await dispatchEligibleRecipients(new Request(origin + url), env, unexpected);
    assert.ok(response);
    await expectDenial(response, 400);
  }
  for (const method of ['HEAD', 'OPTIONS']) {
    const response = await dispatchEligibleRecipients(new Request(origin + path, { method }), env, unexpected);
    assert.ok(response);
    assert.equal(response.headers.get('allow'), 'GET');
    await expectDenial(response, 405);
  }
  const input = new Request(`${origin}${path.replace('source', 'a%2Fb')}?cursor=next`);
  const forwarded = new Response(null);
  assert.equal(await dispatchEligibleRecipients(input, env, async request => {
    assert.equal(request, input);
    return forwarded;
  }), forwarded);
  assert.equal(dispatchEligibleRecipients(new Request(`${origin}/api/entries/source/delete`), env, unexpected), null);
});

test('recipient lookup fails closed on storage errors', async () => {
  const request = new Request(origin + path);
  let calls = 0;
  const broken = { ...env, DB: { ...env.DB, withSession() { calls++; throw new Error('Private storage detail'); } } };
  await expectDenial(await getEligibleRecipients(request, broken, 'a'.repeat(43)), 503);
  assert.equal(calls, 1);
});

test('recipient lookup is closed at Worker and adapter boundaries even with staging Share flags on', async () => {
  const request = new Request(stagingOrigin + path, { headers: { cookie: `__Host-drive-session=${'a'.repeat(43)}` } });
  const staging = { ...env, DRIVE_ORIGIN: stagingOrigin, DRIVE_STAGING_INVITE_ACCEPTANCE: '1', DRIVE_STAGING_READ_GRANTS: '1',
    DRIVE_STAGING_SHARED_LISTING: '1' };
  const handle = privateRequests(staging);
  const adapter = await handle({
    event: { request, route: { id: eligibleRecipientsRoute }, locals: {} },
    resolve: () => assert.fail('The adapter must not resolve the route'),
  } as unknown as Parameters<typeof handle>[0]);
  const assets = { signIn: new Set<string>(), root: new Set<string>(), invite: new Set<string>(), people: new Set<string>(), folder: new Set<string>() };
  const worker = await admitStagingRequest(request, staging, true, assets);
  assert.ok(worker instanceof Response);
  for (const response of [worker, adapter, await getEligibleRecipients(request, staging, 'a'.repeat(43))]) {
    await expectDenial(response, 404);
  }
});
