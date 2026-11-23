import { createHash, randomBytes } from 'node:crypto';
import { readBoundedBody } from '../src/lib/server/bounded-io.ts';
import { firstReleaseUploadCapBytes as cap } from '../src/lib/server/first-release-upload-limit.mjs';
import { MAX_PART_BYTES as partBytes } from '../src/lib/server/s3/multipart-completion.ts';
import { readinessHeaders, readinessPath } from '../src/lib/server/qualification-readiness.ts';
import { fixture as passkey } from '../tests/ceremony-fixture.ts';
import { verifyQualificationDownload } from './staging-qualification-large-transfer.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const opaque = /^[A-Za-z0-9_-]{43}$/;
const loginCookie = '__Host-drive-login';
const sessionCookie = '__Host-drive-session';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyFirstReleaseWorker({ origin, sha, version }, signal, request = fetch) {
  const nonce = randomBytes(16).toString('hex');
  const response = await request(origin + readinessPath, { method: 'HEAD', redirect: 'error',
    cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    headers: { [readinessHeaders.nonce]: nonce } });
  check(response.status === 204 && response.body === null && response.headers.get('cache-control') === 'private, no-store' &&
    response.headers.get(readinessHeaders.nonce) === nonce && response.headers.get(readinessHeaders.sha) === sha &&
    response.headers.get(readinessHeaders.version) === version, 'Worker readiness identity did not match');
}

export async function exerciseFirstReleaseCases(scope, bootstrapToken, signal, request = fetch) {
  const { origin, runId, runAttempt } = scope;
  const rpID = new URL(origin).hostname;
  const tag = `${runId}-${runAttempt}`;
  const cases = {};
  let step = 'readiness';
  const send = (method, path, { body, cookie, headers, active = signal } = {}) => {
    active.throwIfAborted();
    const contentType = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json';
    return request(origin + path, { method, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([active, AbortSignal.timeout(60_000)]),
      headers: { origin, 'sec-fetch-site': 'same-origin', ...(cookie && { cookie }),
        ...(body !== undefined && { 'content-type': contentType }), ...headers },
      body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  };
  async function expect(response, status, parse = false) {
    if (response.status !== status || response.redirected || response.headers.get('cache-control') !== 'private, no-store') {
      await response.body?.cancel();
      throw new Error(`Expected private HTTP ${status}, received ${response.status}`);
    }
    if (!parse) {
      await response.body?.cancel();
      return response;
    }
    check(response.body && response.headers.get('content-type')?.split(';', 1)[0] === 'application/json', 'Expected JSON');
    const bytes = await readBoundedBody(response.body, { signal, maxBytes: 32_768, timeoutMs: 5_000 });
    check(bytes, 'Incomplete JSON');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  function getCookie(response, name, pattern) {
    const candidates = response.headers.getSetCookie().filter(value => value.startsWith(name + '='));
    const pair = candidates[0]?.split(';', 1)[0];
    check(candidates.length === 1 && pattern.test(pair.slice(name.length + 1)), 'Expected session cookie');
    return pair;
  }
  async function identity(options) {
    check(options.rp.id === rpID && opaque.test(options.user.id), 'Unexpected passkey relying party');
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const credentialId = randomBytes(16);
    const { registration } = await passkey('registration', { key, credentialId, origin, rpID, challenge: options.challenge });
    let counter = 1;
    return { registration, async signIn() {
      const issued = await send('POST', '/api/sign-in/challenge');
      const transaction = getCookie(issued, loginCookie, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
      const { challenge } = await expect(issued, 200, true);
      const { authentication } = await passkey('authentication', { key, credentialId, origin, rpID, challenge, counter: ++counter });
      authentication.response.userHandle = options.user.id;
      const verified = await expect(await send('POST', '/api/sign-in/verify', { cookie: transaction, body: authentication }), 204);
      return getCookie(verified, sessionCookie, opaque);
    } };
  }
  try {
    await verifyFirstReleaseWorker(scope, signal, request);

    step = 'owner bootstrap';
    const path = '/api/deployer/owner-enrollment';
    const headers = { authorization: `Bearer ${bootstrapToken}` };
    await expect(await send('POST', path, { body: { operation: 'challenge' } }), 403);
    await expect(await send('POST', path, { headers: { ...headers, origin: 'https://wrong.example.test' },
      body: { operation: 'challenge' } }), 403);
    const { ok, options } = await expect(await send('POST', path, { headers, body: { operation: 'challenge' } }), 200, true);
    check(ok === true, 'Owner challenge failed');
    const owner = await identity(options);
    const enrolled = await expect(await send('POST', path, { headers,
      body: { operation: 'enroll', challenge: options.challenge, response: owner.registration } }), 200, true);
    check(enrolled.ok === true, 'Owner enrollment failed');
    await expect(await send('POST', path, { headers, body: { operation: 'challenge' } }), 409);
    const ownerCookie = await owner.signIn();

    step = 'uninvited denial';
    await expect(await send('GET', '/'), 401);
    await expect(await send('POST', '/api/invite/challenge', { body: { token: randomBytes(32).toString('base64url') } }), 404);
    await expect(await send('POST', '/api/uploads', { body: { size: cap } }), 401);
    cases.uninvitedDenial = 'pass';

    step = 'invite';
    async function invite(role) {
      const displayName = `Smoke ${role} ${tag}`;
      const { token } = await expect(await send('POST', '/api/owner/invitations', {
        cookie: ownerCookie, body: { displayName },
      }), 201, true);
      check(opaque.test(token), 'Invalid invitation');
      const { options } = await expect(await send('POST', '/api/invite/challenge', { body: { token } }), 200, true);
      const member = await identity(options);
      await expect(await send('POST', '/api/invite/enroll', {
        body: { token, challenge: options.challenge, response: member.registration },
      }), 204);
      await expect(await send('POST', '/api/invite/challenge', { body: { token } }), 404);
      const cookie = await member.signIn();
      await expect(await send('HEAD', '/', { cookie }), 200);
      return { ...member, cookie };
    }
    const uploader = await invite('uploader');
    const recipient = await invite('recipient');
    cases.invite = 'pass';

    step = 'over-cap refusal';
    const full = randomBytes(partBytes);
    const tail = randomBytes(cap - partBytes);
    const fullHash = sha256(full);
    const expectedPartSha256s = fullHash + sha256(tail);
    for (const body of [{ size: cap + 1 }, { size: cap + 1, expectedPartSha256s }]) {
      await expect(await send('POST', '/api/uploads', { body, cookie: uploader.cookie }), 400);
      await expect(await send('POST', '/api/uploads', { body, cookie: ownerCookie }), 400);
    }

    step = 'multipart resume';
    const initial = new AbortController();
    const active = AbortSignal.any([signal, initial.signal]);
    const { id: intent } = await expect(await send('POST', '/api/uploads', {
      active, cookie: uploader.cookie, body: { size: cap, expectedPartSha256s },
    }), 201, true);
    check(uuid.test(intent), 'Invalid upload intent');
    const upload = `/api/uploads/${intent}`;
    await expect(await send('PUT', upload + '/parts/1', { active, cookie: uploader.cookie, body: full }), 204);
    // Disconnect at the acknowledged boundary. A part with uncertain provider outcome must stay fenced.
    initial.abort();
    const resumedCookie = await uploader.signIn();
    check(resumedCookie !== uploader.cookie, 'Resume needs a fresh session');
    await expect(await send('GET', upload + '/resume', { cookie: recipient.cookie }), 404);
    const evidence = await expect(await send('GET', upload + '/resume', { cookie: resumedCookie }), 200, true);
    check(evidence.declaredSize === cap && evidence.expectedPartSha256s === expectedPartSha256s &&
      evidence.parts?.length === 1 && evidence.parts[0].partNumber === 1 &&
      evidence.parts[0].sizeBytes === partBytes && evidence.parts[0].sha256 === fullHash, 'Unexpected resume evidence');
    await expect(await send('PUT', upload + '/parts/2', {
      cookie: resumedCookie, body: Buffer.concat([tail, Buffer.of(0)]),
    }), 404);
    cases.overCapRefusal = 'pass';
    await expect(await send('PUT', upload + '/parts/2', { cookie: resumedCookie, body: tail }), 204);
    const { id: file } = await expect(await send('POST', upload + '/complete', {
      cookie: resumedCookie, body: { name: `smoke-${tag}.bin`, parentId: null },
    }), 201, true);
    check(uuid.test(file), 'Invalid published entry');
    cases.multipartResume = 'pass';

    step = 'byte-identical download';
    const download = `/api/download/${file}`;
    const hash = createHash('sha256').update(full).update(tail).digest('hex');
    const verifyDownload = async cookie => verifyQualificationDownload(await send('GET', download, { cookie }), cap, hash, signal);
    await verifyDownload(resumedCookie);
    await expect(await send('GET', download), 401);
    cases.byteIdenticalDownload = 'pass';

    step = 'share';
    await expect(await send('GET', download, { cookie: recipient.cookie }), 404);
    const { recipients, nextCursor } = await expect(await send('GET', `/api/entries/${file}/eligible-recipients`,
      { cookie: resumedCookie }), 200, true);
    // The disposable database contains only the owner and these two invitees.
    check(Array.isArray(recipients) && recipients.length === 1 && nextCursor === null &&
      uuid.test(recipients[0].recipientId) && recipients[0].direct === false, 'Synthetic recipient missing from eligible roster');
    const { recipientId } = recipients[0];
    const grant = `/api/entries/${file}/read-grants/${recipientId}`;
    await expect(await send('PUT', grant, { cookie: resumedCookie }), 204);
    await verifyDownload(recipient.cookie);
    cases.share = 'pass';

    step = 'revoke';
    await expect(await send('DELETE', grant, { cookie: resumedCookie }), 204);
    await expect(await send('GET', download, { cookie: recipient.cookie }), 404);
    await expect(await send('POST', `/api/owner/members/${recipientId}/revoke`, { cookie: ownerCookie }), 204);
    await expect(await send('HEAD', '/', { cookie: recipient.cookie }), 401);
    cases.revoke = 'pass';

    step = 'permanent deletion unavailable';
    for (const cookie of [resumedCookie, ownerCookie]) {
      await expect(await send('POST', `/api/entries/${file}/delete`, { cookie }), 404);
      await expect(await send('DELETE', `/api/entries/${file}`, { cookie }), 404);
    }
    await verifyDownload(resumedCookie);
    cases.permanentDeletionUnavailable = 'pass';
    await verifyFirstReleaseWorker(scope, signal, request);
    return cases;
  } catch (error) {
    // Keep provider responses, assertions, fixtures and cookies out of workflow logs.
    throw new Error(`Drive first-release smoke failed during ${step}${error?.message?.startsWith('Expected private HTTP ') ? ': ' + error.message : ''}.`);
  }
}
