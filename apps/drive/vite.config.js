import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
// Node executes this build configuration; Node type declarations are not app dependencies.
// @ts-ignore
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// @ts-ignore
import { relative, resolve } from 'node:path';

/** @param {import('@sveltejs/kit').Builder} builder */
function previewAssets(builder) {
  /** @type {import('vite').Manifest} */
  const manifest = JSON.parse(readFileSync(`${builder.getClientDirectory()}/.vite/manifest.json`, 'utf8'));
  const generated = relative('.', `${builder.getBuildDirectory('generated')}/build/client-optimized`).replaceAll('\\', '/');
  const nodes = `${generated}/nodes`;
  /** @param {string} source */
  function leaf(source) {
    const matches = readdirSync(nodes).filter((/** @type {string} */ file) =>
      /^\d+\.js$/.test(file) && readFileSync(`${nodes}/${file}`, 'utf8').includes(source));
    if (matches.length !== 1) throw new Error(`Could not locate preview client entry: ${source}`);
    return `${nodes}/${matches[0]}`;
  }
  const start = Object.keys(manifest).find((key) => key.endsWith('/@sveltejs/kit/src/runtime/client/entry.js'));
  const runtime = start && manifest[start]?.dynamicImports?.find((key) => key.endsWith('/client-entry.js'));
  if (!start || !runtime) throw new Error('Could not locate sign-in client entries');
  /** @type {Set<string>} */
  const assets = new Set();
  const visited = new Set();
  /** @param {string} key @param {boolean} [stylesOnly] */
  function include(key, stylesOnly = false) {
    const visit = `${stylesOnly}:${key}`;
    if (visited.has(visit)) return;
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing preview dependency: ${key}`);
    visited.add(visit);
    for (const file of [entry.file, ...entry.css ?? [], ...entry.assets ?? []]) {
      if (stylesOnly && !/\.(?:css|woff2)$/.test(file)) continue;
      if (!file.startsWith(`${builder.getAppPath()}/immutable/`) || !/^[\w./-]+\.(?:js|css|woff2)$/.test(file)) {
        throw new Error(`Unexpected preview asset: ${file}`);
      }
      assets.add(`/${file}`);
    }
    entry.imports?.forEach(key => include(key, stylesOnly));
  }
  // Sign-in hydrates. The read-only root needs only its styles and fonts.
  // Neither traversal follows dynamic imports.
  [start, runtime, `${generated}/app.js`, `${nodes}/0.js`, `${nodes}/1.js`, leaf('/src/routes/sign-in/+page.svelte')]
    .forEach(key => include(key));
  const signIn = [...assets];
  assets.clear();
  include(leaf('/src/routes/+page.svelte'), true);
  return { signIn, root: [...assets] };
}

// The adapter writes its output to Wrangler's main, so never point it at the
// fail-closed source Worker. Keep the generated-app config temporary instead.
const configPath = resolve('.svelte-kit/adapter-wrangler.json');
const cloudflare = adapter({ config: configPath, platformProxy: { configPath: 'wrangler.build.jsonc' } });
const buildAdapter = {
  ...cloudflare,
  /** @param {import('@sveltejs/kit').Builder} builder */
  async adapt(builder) {
    const config = JSON.parse(readFileSync('wrangler.build.jsonc', 'utf8'));
    config.main = resolve('.svelte-kit/cloudflare-tmp/adapter-worker.js');
    config.assets.directory = resolve(config.assets.directory);
    mkdirSync(resolve('.svelte-kit'), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config));
    try {
      await cloudflare.adapt(builder);
      // The adapter can answer before the hook. Gate requests at the outer Worker.
      writeFileSync(resolve(config.assets.directory, '_worker.js'), `
import adapterWorker from '../cloudflare-tmp/adapter-worker.js';
import { admitsSignInFixture, allowsOrigin, stagingOrigin } from '../../src/lib/server/request-auth.ts';
import { signIn } from '../../src/lib/server/sign-in.ts';
import { dispatchStagingRequest } from '../../src/lib/server/staging-admission.ts';
import { wireUploadStorage } from '../../src/lib/server/storage-runtime.ts';

const appPath = ${JSON.stringify(`/${builder.getAppPath()}`)};
const generated = ${JSON.stringify(previewAssets(builder))};
const assets = { signIn: new Set(generated.signIn), root: new Set(generated.root) };
const fixtureAssets = new Set([...assets.signIn, ...assets.root]);
const signInStep = /^\\/api\\/sign-in\\/(challenge|restart|verify)$/;
const unavailable = () => new Response('Service unavailable', {
  status: 503,
  headers: { 'cache-control': 'no-store' }
});
const unavailableAssets = { fetch: unavailable };

export default {
  async fetch(request, env, ctx) {
    if (env.DRIVE_ORIGIN === stagingOrigin) {
      const storage = wireUploadStorage(env);
      const ready = !!storage.DRIVE_UPLOAD_VERIFIER && typeof env.DB?.batch === 'function' &&
        typeof env.ASSETS?.fetch === 'function';
      return dispatchStagingRequest(request, env, ready, assets, {
        adapter: request => adapterWorker.fetch(request, { ...env, ASSETS: unavailableAssets }, ctx),
        ceremony: (request, step) => signIn(request, step, env),
        asset: request => env.ASSETS.fetch(request)
      });
    }
    if (!admitsSignInFixture(env)) return unavailable();
    const url = new URL(request.url);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return unavailable();
    }
    const step = signInStep.exec(url.pathname)?.[1];
    if (step) return signIn(request, step, env);
    if (fixtureAssets.has(url.pathname) && env.ASSETS &&
        (request.method === 'GET' || request.method === 'HEAD') && allowsOrigin(request, env.DRIVE_ORIGIN)) {
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      response.headers.set('cache-control', 'private, no-store');
      return response;
    }
    if (pathname === appPath || pathname.startsWith(appPath + '/')) return unavailable();
    return adapterWorker.fetch(request, { ...env, ASSETS: unavailableAssets }, ctx);
  }
};
`);
    } finally {
      rmSync(configPath, { force: true });
    }
  }
};

export default defineConfig({
  plugins: [sveltekit({ adapter: buildAdapter })]
});
