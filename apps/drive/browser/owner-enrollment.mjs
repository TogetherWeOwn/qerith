import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempDisposable, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler';

const origin = 'https://qerith-drive-staging.5150.workers.dev';
const path = '/api/deployer/owner-enrollment';
const challenge = { operation: 'challenge' };

export async function proveOwnerEnrollment(browser) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Owner enrollment fixture requires GitHub Actions');
  await using dir = await mkdtempDisposable(`${process.env.RUNNER_TEMP}/drive-owner-enrollment-`);
  const config = JSON.parse(await readFile('../wrangler.build.jsonc', 'utf8'));
  const configPath = resolve(dir.path, 'wrangler.json');
  const main = resolve(dir.path, 'owner-fixture.mjs');
  // Exercise the generated enrollment route. Wire ordinary sign-in only in this
  // temporary fixture: live staging sign-in still requires separate ingress evidence.
  await writeFile(main, `import worker from ${JSON.stringify(resolve('../.svelte-kit/cloudflare/_worker.js'))};
import { signIn } from ${JSON.stringify(resolve('../src/lib/server/sign-in.ts'))};
export default { fetch(request, env, ctx) {
  const step = /^\\/api\\/sign-in\\/(challenge|verify)$/.exec(new URL(request.url).pathname)?.[1];
  if (step) return signIn(request, step, env);
  const mode = request.headers.get('x-owner-fixture-mode');
  return worker.fetch(request, { ...env,
    DRIVE_OWNER_ENROLLMENT_RELEASE: mode === 'inactive' ? 'disabled' : env.DRIVE_OWNER_ENROLLMENT_RELEASE,
    DRIVE_OWNER_ENROLLMENT: mode === 'missing' ? undefined : mode === 'expired' ?
      env.DRIVE_OWNER_ENROLLMENT.replace(/:\\d{13}:/, ':1000000000000:') : env.DRIVE_OWNER_ENROLLMENT,
  }, ctx);
} };`);
  await writeFile(configPath, JSON.stringify({ ...config, main,
    assets: { ...config.assets, directory: resolve('..', config.assets.directory) },
    d1_databases: [{ binding: 'DB', database_name: 'owner-enrollment-fixture', database_id: '00000000-0000-4000-8000-000000000002' }],
  }));
  const bearer = `Bearer ${randomBytes(32).toString('base64url')}`;
  const sha = 'a'.repeat(40);
  const harness = createTestHarness({ workers: [{ configPath, vars: {
    DRIVE_ORIGIN: origin, DRIVE_OWNER_ENROLLMENT_RELEASE: sha,
    DRIVE_OWNER_ENROLLMENT: `${sha}:${Date.now() + 300_000}:${bearer.slice(7)}`,
  } }] });
  const context = await browser.newContext();
  try {
    await harness.listen();
    const worker = harness.getWorker();
    const { DB } = await worker.getEnv();
    for (const name of (await readdir('../migrations')).filter(name => name.endsWith('.sql')).sort()) {
      await DB.batch(unstable_splitSqlQuery(await readFile(`../migrations/${name}`, 'utf8')).map(sql => DB.prepare(sql)));
    }
    const post = (path, body, extra = {}) => worker.fetch(`${origin}${path}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
    });
    const authorization = { authorization: bearer };
    const attempt = (input, extra = authorization) => post(path, input, extra);
    const expect = async (response, status) => {
      const { status: actual, headers } = await response;
      assert.equal(actual, status);
      assert.equal(headers.get('cache-control'), 'private, no-store');
    };
    await expect(attempt(challenge, {}), 403);
    await expect(attempt(challenge, { authorization: `Bearer ${'a'.repeat(43)}` }), 403);
    await expect(attempt(challenge, { ...authorization, origin: 'https://wrong.example.test' }), 403);
    await expect(attempt(challenge, { ...authorization, 'x-owner-fixture-mode': 'missing' }), 503);
    await expect(attempt(challenge, { ...authorization, 'x-owner-fixture-mode': 'inactive' }), 503);
    await expect(attempt(challenge, { ...authorization, 'x-owner-fixture-mode': 'expired' }), 503);
    await expect(attempt({ ...challenge, padding: 'a'.repeat(32 * 1024) }), 400);
    assert.equal(await DB.prepare('SELECT 1 FROM drive_owner_registration').first(), null);
    await DB.prepare(`CREATE TRIGGER fixture_failure BEFORE INSERT ON drive_owner_registration
      BEGIN SELECT RAISE(ABORT, 'fixture write denied'); END`).run();
    await expect(attempt(challenge), 503);
    await DB.prepare('DROP TRIGGER fixture_failure').run();

    // Never contact live staging: Playwright fulfills only a synthetic document on the pinned RP origin.
    await context.route('**/*', route => route.request().url() === `${origin}/`
      ? route.fulfill({ contentType: 'text/html', body: '<title>Owner fixture</title>' }) : route.abort());
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } });
    await page.goto(`${origin}/`);
    const create = async () => {
      const issued = await attempt(challenge);
      await expect(issued, 200);
      const { options } = await issued.json();
      assert.equal(options.rp.id, new URL(origin).hostname);
      return page.evaluate(async options => {
        const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
        return { operation: 'enroll', challenge: options.challenge, response: credential.toJSON() };
      }, options);
    };
    const expired = await create();
    await expect(attempt(expired, {}), 403);
    await expect(attempt(expired, { ...authorization, 'x-owner-fixture-mode': 'expired' }), 503);
    await DB.prepare('UPDATE drive_owner_registration SET expires_at = 1').run();
    await expect(attempt(expired), 400);
    await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
    const enrollment = await create();
    await expect(attempt(enrollment), 200);
    await expect(attempt(enrollment), 409);
    await expect(attempt(expired), 409);
    await expect(attempt(challenge), 409);
    assert.equal(await DB.prepare('SELECT 1 FROM drive_owner_registration').first(), null);
    const { count, owner } = await DB.prepare("SELECT count(*) AS count, id AS owner FROM drive_principals WHERE role = 'owner'").first();
    assert.equal(count, 1);

    const issued = await post('/api/sign-in/challenge', {});
    await expect(issued, 200);
    const assertion = await page.evaluate(async options => {
      const credential = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options) });
      return credential.toJSON();
    }, await issued.json());
    const signedIn = await post('/api/sign-in/verify', assertion, { cookie: issued.headers.get('set-cookie').split(';')[0] });
    await expect(signedIn, 204);
    const session = /^__Host-drive-session=([A-Za-z0-9_-]{43});/.exec(signedIn.headers.get('set-cookie'));
    assert.ok(session, 'sign-in did not return a session cookie');
    const hash = createHash('sha256').update(session[1]).digest('hex');
    assert.equal(await DB.prepare('SELECT principal_id FROM drive_sessions WHERE token_hash = ?').bind(hash).first('principal_id'), owner);
    console.log('Generated Worker + Chromium + disposable D1: first-owner enrollment, sign-in and denial cases passed');
  } finally {
    await context.close();
    await harness.close();
  }
}
