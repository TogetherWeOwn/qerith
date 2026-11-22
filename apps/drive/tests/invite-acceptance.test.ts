import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { CeremonyCapacityReached } from '../src/lib/server/identity/challenges';
import { inviteAcceptance, type InviteRegistration } from '../src/lib/server/invite-acceptance';

const origin = 'https://drive.example.test';
const token = 'i'.repeat(43), cookie = `__Host-drive-session=${'s'.repeat(43)}`;
const challenge = Buffer.alloc(64, 1).toString('base64url');
const headers = { origin, 'content-type': 'application/json' };
const options = { challenge, rp: { name: 'Drive' }, user: { id: 'handle', name: 'Guest', displayName: 'Guest' }, pubKeyCredParams: [] };
const response = { id: 'key', rawId: 'key', type: 'public-key', clientExtensionResults: {}, response: {
  clientDataJSON: Buffer.from(JSON.stringify({ challenge, origin, type: 'webauthn.create' })).toString('base64url'),
  attestationObject: 'attestation',
} };
const request = (init: RequestInit = {}, url = `${origin}/invite`) =>
  new Request(url, { method: 'POST', headers, body: JSON.stringify({ token }), ...init });

function fixture(state: 'live' | 'missing' | 'fault' | 'member' | 'throttled' = 'live') {
  const calls: unknown[] = [];
  const prepare = (sql: string) => ({
    bind() { return this; },
    async first<T>(): Promise<T | null> {
      calls.push(sql.includes('FROM drive_sessions') ? 'session' : 'present');
      if (state === 'fault') throw new Error(token);
      return (state === 'member' ? { id: 'principal', role: 'member' }
        : state === 'live' ? { display_name: 'Guest', note: null } : null) as T | null;
    },
    async all<T>(): Promise<{ results: T[] }> { throw new Error('Unexpected database call'); },
  });
  const registration: InviteRegistration = {
    async issueOptions(value) {
      calls.push(['challenge', value]);
      if (state === 'throttled') throw new CeremonyCapacityReached();
      return state === 'live' ? options : null;
    },
    async enroll(...args) { calls.push(['enroll', ...args]); return state === 'live'; },
  };
  const run = (req: Request, step: Parameters<typeof inviteAcceptance>[1] = 'present') =>
    inviteAcceptance(req, step, { DRIVE_ORIGIN: origin, DB: { prepare } }, registration);
  return { run, calls };
}

function assertPolicy(result: Response, status: number) {
  assert.equal(result.status, status);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  for (const name of ['set-cookie', 'location', 'access-control-allow-origin']) assert.equal(result.headers.get(name), null);
  if (status !== 200) assert.equal(result.body, null);
}

void test('presents only display data and dispatches only the known WebAuthn fields', async () => {
  const { run, calls } = fixture();
  const display = await run(request());
  assertPolicy(display, 200);
  assert.deepEqual(await display.json(), { displayName: 'Guest', note: null });
  const issued = await (await run(request(), 'challenge')).json();
  assert.deepEqual(issued, { options });
  const body = JSON.stringify({ token, challenge: issued.options.challenge, response: { ...response, extra: token } });
  assertPolicy(await run(request({ body }), 'enroll'), 204);
  assert.deepEqual(calls, ['present', ['challenge', token], ['enroll', token, challenge, response]]);
});

void test('denies invalid HTTP input without consulting any service', async () => {
  const { run, calls } = fixture();
  assertPolicy(await run(request({ method: 'GET', body: null })), 405);
  assertPolicy(await run(request({ headers: { ...headers, origin: `${origin}/` } })), 403);
  assertPolicy(await run(request({}, `${origin}:8443/invite`)), 403);
  assertPolicy(await run(request({}, `${origin}/invite?token=${token}`)), 403);
  for (const body of ['{', '{"token":"invalid"}', new Uint8Array([0xff])]) assertPolicy(await run(request({ body })), 400);
  assertPolicy(await run(request({ body: JSON.stringify({ token, challenge, response: {} }) }), 'enroll'), 400);
  assert.deepEqual(calls, []);
});

void test('bounds bytes, empty chunks and stalled reads without awaiting teardown', { timeout: 5_000 }, async () => {
  const { run, calls } = fixture();
  for (const chunk of [new Uint8Array(32 * 1024 + 1), new Uint8Array(0), null]) {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { if (chunk) controller.enqueue(chunk); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const init = { body, duplex: 'half' };
    assertPolicy(await run(request(init)), 400);
    assert.equal(cancelled, true);
  }
  assert.deepEqual(calls, []);
});

void test('cancels an interrupted invite body before consulting any service', { timeout: 5_000 }, async () => {
  const { run, calls } = fixture();
  const caller = new AbortController();
  const reason = new Error('request interrupted');
  const reading = Promise.withResolvers<void>();
  let cancelled: unknown;
  const body = new ReadableStream<Uint8Array>({
    pull() { reading.resolve(); },
    cancel(value) { cancelled = value; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  const init = { body, signal: caller.signal, duplex: 'half' };
  const result = run(request(init), 'challenge');
  await reading.promise;
  caller.abort(reason);
  assertPolicy(await result, 400);
  assert.equal(cancelled, reason);
  assert.equal(body.locked, false);
  assert.deepEqual(calls, []);
});

void test('refuses live or ambiguous sessions and separates invite denial from database faults', async () => {
  const live = fixture('member');
  const body = JSON.stringify({ token, challenge, response });
  assertPolicy(await live.run(request({ headers: { ...headers, cookie }, body }), 'enroll'), 404);
  assertPolicy(await live.run(request({ headers: { ...headers, cookie: `${cookie}; ${cookie}` } }), 'challenge'), 404);
  assert.deepEqual(live.calls, ['session']);
  assertPolicy(await fixture('missing').run(request()), 404);
  assertPolicy(await fixture('missing').run(request(), 'challenge'), 404);
  assertPolicy(await fixture('missing').run(request({ body }), 'enroll'), 404);
  assertPolicy(await fixture('fault').run(request()), 503);
});

void test('translates challenge throttling to a non-cacheable retry response', async () => {
  const result = await fixture('throttled').run(request(), 'challenge');
  assertPolicy(result, 429);
  assert.equal(result.headers.get('retry-after'), '60');
});
