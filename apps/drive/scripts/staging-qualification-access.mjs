import { qualificationPrefix } from './staging-qualification.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';

const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const displayName = 'Qualification member';
const filePath = file => `/api/download/${file.id}`;
const isId = value => typeof value === 'string' && id.test(value);
const isFile = file => isId(file?.id) && Buffer.isBuffer(file.bytes) && file.bytes.length > 0 && file.bytes.length <= 4096;
const require = condition => { if (!condition) throw new Error(); };

async function observeFixtures(withFixtures, identity, signal, observe) {
  const controller = new AbortController();
  const active = AbortSignal.any([signal, controller.signal]);
  let open = true, invoking = true, invocations = 0, settled = false, work, drained;
  const close = () => {
    if (!open) return;
    open = false;
    drained = settled && invocations === 1;
    if (!drained) controller.abort();
  };
  try {
    const result = withFixtures(identity, active, fixtures => {
      const accepted = open && ++invocations === 1;
      const attempt = (async () => {
        require(accepted);
        // Let an already-settled adapter close admission before a queued callback starts I/O.
        if (!invoking) await Promise.resolve();
        require(open);
        active.throwIfAborted();
        try { await observe(fixtures, active); }
        finally { settled = true; }
      })();
      attempt.catch(() => {}); // A broken adapter may discard the promise.
      if (accepted) work = attempt;
      return attempt;
    });
    invoking = false;
    // Subscribe directly so promise assimilation cannot delay closing admission.
    const completion = Promise.withResolvers();
    Promise.prototype.then.call(result,
      () => { close(); completion.resolve(); },
      error => { close(); completion.reject(error); });
    await completion.promise;
  } finally {
    close();
    // Do not let lifecycle cleanup race an observation the adapter abandoned.
    await work?.catch(() => {});
  }
  if (drained) await work;
  return drained;
}

// Unwired. withFixtures returns a native Promise, awaits one callback inside the
// exact attempt's scope, and drains on abort. It provides three initially signed-out,
// isolated clients, a seeded owner passkey and two unshared files under that scope.
// memberFile provisions the invitee's file after sign-in and binds it to that membership.
// Browser methods drive normal WebAuthn sign-in/enrollment and return observed
// HTTP responses as bounded Response snapshots, not verdicts. Preserve redirect
// and Set-Cookie presence, not cookie values. The signed-out client uses an
// unregistered virtual credential. Never seed or export sessions.
export async function exerciseQualificationAccess(context, signal, { withFixtures }) {
  let check = 'fixture-scope';
  try {
    require(context.prefix === qualificationPrefix(context) && typeof context.sha === 'string' && /^[0-9a-f]{40}$/.test(context.sha));
    return await runQualificationPhase(async (identity, active) => {
      const drained = await observeFixtures(withFixtures, identity, active, async (fixtures, active) => {
        const { owner, member, signedOut, ownerFile, memberFile } = fixtures;
        require(new Set([owner, member, signedOut]).size === 3 && isFile(ownerFile));
        const expect = (response, status) => {
          active.throwIfAborted();
          require(response.status === status && !response.redirected && !response.headers.has('location') &&
            response.headers.get('cache-control') === 'private, no-store');
          return response;
        };
        const empty = async (response, status) => {
          require((await expect(response, status).arrayBuffer()).byteLength === 0 && !response.headers.has('content-disposition') &&
            !response.headers.has('set-cookie'));
        };
        const request = (client, path, method = 'GET', json) => {
          active.throwIfAborted();
          return client.request(path, { method, json, redirect: 'manual', signal: active });
        };
        const session = async (client, status) => empty(await request(client, '/', 'HEAD'), status);
        const signIn = async (client, status, code) => {
          active.throwIfAborted();
          const { challenge, verify } = await client.signIn(active);
          expect(challenge, 200);
          expect(verify, status);
          if (code) {
            const denial = await verify.json();
            require(denial?.code === code && Object.keys(denial).length === 1 && !verify.headers.has('set-cookie'));
          } else require(verify.headers.has('set-cookie'));
          await session(client, code ? 401 : 200);
        };
        const read = async (client, file) => {
          const body = expect(await request(client, filePath(file)), 200);
          require(body.headers.get('content-length') === String(file.bytes.length) &&
            file.bytes.equals(Buffer.from(await body.arrayBuffer())));
        };

        check = 'passkey-positive';
        await session(owner, 401);
        await signIn(owner, 204);
        await read(owner, ownerFile);
        check = 'passkey-negative';
        await session(signedOut, 401);
        await signIn(signedOut, 401, 'denied');

        check = 'invite-acceptance';
        await session(member, 401);
        const { token } = await expect(await request(owner, '/api/owner/invitations', 'POST', { displayName }), 201).json();
        require(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token));
        active.throwIfAborted();
        const { present, challenge, enroll } = await member.acceptInvite(token, active);
        require((await expect(present, 200).json()).displayName === displayName);
        expect(challenge, 200);
        await empty(enroll, 204);
        await session(member, 401);
        await empty(await request(signedOut, '/api/invite/present', 'POST', { token }), 404);
        await signIn(member, 204);

        check = 'cross-user-denial';
        active.throwIfAborted();
        const file = await memberFile(member, active);
        require(isFile(file) && isId(file.memberId) && file.id !== ownerFile.id && !file.bytes.equals(ownerFile.bytes));
        await read(member, file);
        await empty(await request(member, filePath(ownerFile)), 404);
        await empty(await request(owner, filePath(file)), 404);
        check = 'unauthenticated-file-denial';
        for (const target of [ownerFile, file]) await empty(await request(signedOut, filePath(target)), 401);

        check = 'member-revocation';
        await empty(await request(owner, `/api/owner/members/${file.memberId}/revoke`, 'POST'), 204);
        // Keep the existing browser session for this request; do not log out first.
        await empty(await request(member, filePath(file)), 401);
        await signIn(member, 403, 'revoked');
        await read(owner, ownerFile);
      });
      check = 'fixture-scope';
      require(drained);
      return { 'passkey-positive': 'pass', 'passkey-negative': 'pass', 'invite-acceptance': 'pass',
        'cross-user-denial': 'pass', 'unauthenticated-file-denial': 'pass', 'member-revocation': 'pass' };
    }, context, signal, 90_000);
  } catch {
    // Adapter errors may include cookies, invite links or browser request data.
    throw new Error(`Qualification access is unverified (${check}).`);
  }
}
