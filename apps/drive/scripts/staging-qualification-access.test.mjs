import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { exerciseQualificationAccess } from './staging-qualification-access.mjs';

// The composition test imports the fixture without re-registering this suite.
const test = import.meta.main ? nodeTest : () => {};
export { fixture as accessFixture };

const context = { sha: 'a'.repeat(40), runId: '4', attempt: '2', prefix: 'drive-qualification/full-v0/4/2/' };
const token = 'x'.repeat(43);
const uuid = digit => `00000000-0000-4000-8000-00000000000${digit}`;
const ownerFile = { id: uuid(1), bytes: Buffer.from([0, 255]) };
const otherFile = { id: uuid(2), bytes: Buffer.from([255, 0]), memberId: uuid(3) };
const first = `/api/download/${uuid(1)}`, second = `/api/download/${uuid(2)}`;
const reply = (status, body = null, headers = {}) => new Response(body, {
  status, headers: { 'cache-control': 'private, no-store', ...headers },
});
const data = (status, body) => reply(status, JSON.stringify(body));
const bytes = file => reply(200, file.bytes, { 'content-length': '2' });
const login = verify => ({ challenge: reply(200), verify });
const accepted = () => login(reply(204, null, { 'set-cookie': 'present' }));

function fixture(change = () => {}, expectedContext = context) {
  const transcript = [
    ['owner HEAD /', reply(401)], ['owner sign-in', accepted()],
    ['owner HEAD /', reply(200)], [`owner GET ${first}`, bytes(ownerFile)],
    ['signedOut HEAD /', reply(401)], ['signedOut sign-in', login(data(401, { code: 'denied' }))], ['signedOut HEAD /', reply(401)],
    ['member HEAD /', reply(401)], ['owner POST /api/owner/invitations', data(201, { token }), { displayName: 'Qualification member' }],
    ['member invite', { present: data(200, { displayName: 'Qualification member' }), challenge: reply(200), enroll: reply(204) }, token],
    ['member HEAD /', reply(401)], ['signedOut POST /api/invite/present', reply(404), { token }],
    ['member sign-in', accepted()], ['member HEAD /', reply(200)], ['member file setup', otherFile],
    [`member GET ${second}`, bytes(otherFile)], [`member GET ${first}`, reply(404)], [`owner GET ${second}`, reply(404)],
    [`signedOut GET ${first}`, reply(401)], [`signedOut GET ${second}`, reply(401)],
    [`owner POST /api/owner/members/${uuid(3)}/revoke`, reply(204)], [`member GET ${second}`, reply(401)],
    ['member sign-in', login(data(403, { code: 'revoked' }))], ['member HEAD /', reply(401)], [`owner GET ${first}`, bytes(ownerFile)],
  ];
  let closed = false;
  const withFixtures = async (scope, signal, run) => {
    assert.deepEqual(scope, expectedContext);
    const step = (command, active, input) => {
      assert.equal(active, signal);
      const [expected, observation, args] = transcript.shift();
      assert.equal(command, expected);
      assert.deepEqual(input, args);
      return change(command, observation) ?? observation;
    };
    const client = name => ({
      request(path, { method, json, redirect, signal }) {
        assert.equal(redirect, 'manual');
        return step(`${name} ${method} ${path}`, signal, json);
      },
      signIn: signal => step(`${name} sign-in`, signal),
      acceptInvite: (token, signal) => step(`${name} invite`, signal, token),
    });
    const member = client('member');
    try {
      await run({ owner: client('owner'), member, signedOut: client('signedOut'), ownerFile, memberFile(actor, signal) {
        assert.equal(actor, member);
        return step('member file setup', signal);
      } });
    } finally { closed = true; }
  };
  return { withFixtures, transcript, closed: () => closed };
}

test('all six access cases require the exact isolated browser transcript', async () => {
  const scope = fixture();
  assert.deepEqual(await exerciseQualificationAccess(context, undefined, scope), {
    'passkey-positive': 'pass', 'passkey-negative': 'pass', 'invite-acceptance': 'pass',
    'cross-user-denial': 'pass', 'unauthenticated-file-denial': 'pass', 'member-revocation': 'pass',
  });
  assert.equal(scope.transcript.length, 0);
  assert.equal(scope.closed(), true);
});

for (const [description, step, replacement, check] of [
  ['missing verify cookie', 'owner sign-in', () => login(reply(204)), 'passkey-positive'],
  ['missing positive file route', `owner GET ${first}`, () => reply(404), 'passkey-positive'],
  ['wrong negative passkey code', 'signedOut sign-in', () => login(data(401, { code: 'unavailable' })), 'passkey-negative'],
  ['extra denial fields', 'signedOut sign-in', () => login(data(401, { code: 'denied', extra: true })), 'passkey-negative'],
  ['missing verify route', 'signedOut sign-in', () => login(reply(404)), 'passkey-negative'],
  ['missing invite present route', 'member invite', result => ({ ...result, present: reply(404) }), 'invite-acceptance'],
  ['reusable invite', 'signedOut POST /api/invite/present', () => reply(200), 'invite-acceptance'],
  ['wrong same-length member bytes', `member GET ${second}`, () => bytes(ownerFile), 'cross-user-denial'],
  ['cross-user disclosure to the owner', `owner GET ${second}`, () => bytes(otherFile), 'cross-user-denial'],
  ['cross-user denial leaks bytes', `member GET ${first}`, () => reply(404, Buffer.from([0xef, 0xbb, 0xbf])), 'cross-user-denial'],
  ['signed-out request redirects', `signedOut GET ${second}`, () => reply(303, null, { location: '/sign-in' }), 'unauthenticated-file-denial'],
  ['revocation leaves existing session active', `member GET ${second}`, result => result.status === 401 ? bytes(otherFile) : result, 'member-revocation'],
  ['revoked passkey still signs in', 'member sign-in', result => result.verify.status === 403 ? accepted() : result, 'member-revocation'],
]) test(description, async () => {
  const scope = fixture((command, result) => command === step ? replacement(result) : result);
  await assert.rejects(exerciseQualificationAccess(context, undefined, scope), {
    message: `Qualification access is unverified (${check}).`,
  });
  assert.equal(scope.closed(), true);
});

test('a settled duplicate callback invalidates a complete transcript', async () => {
  const scope = fixture();
  let duplicate;
  await assert.rejects(exerciseQualificationAccess(context, undefined, {
    withFixtures: (identity, active, run) => scope.withFixtures(identity, active, async fixtures => {
      await run(fixtures);
      [duplicate] = await Promise.allSettled([run()]);
    }),
  }), { message: 'Qualification access is unverified (fixture-scope).' });
  assert.equal(duplicate.status, 'rejected');
  assert.equal(scope.transcript.length, 0);
  assert.equal(scope.closed(), true);
});

test('scope mismatch, zero observations, cancellation and adapter errors cannot yield results', async () => {
  const fail = { message: 'Qualification access is unverified (fixture-scope).' };
  let opened = false;
  const withFixtures = () => { opened = true; };
  await assert.rejects(exerciseQualificationAccess({ ...context, attempt: '3' }, undefined, { withFixtures }), fail);
  assert.equal(opened, false);
  await assert.rejects(exerciseQualificationAccess(context, undefined, { withFixtures }), fail);
  await assert.rejects(exerciseQualificationAccess(context, undefined, { withFixtures: () => { throw new Error(token); } }), fail);
  const controller = new AbortController();
  const scope = fixture(command => { if (command === 'owner sign-in') controller.abort(); });
  await assert.rejects(exerciseQualificationAccess(context, controller.signal, scope), /unverified/);
  assert.equal(scope.transcript[0][0], 'owner HEAD /');
  assert.equal(scope.closed(), true);
});
