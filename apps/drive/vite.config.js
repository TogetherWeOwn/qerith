import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
// Node executes this build configuration; Node type declarations are not app dependencies.
// @ts-ignore
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// @ts-ignore
import { relative, resolve } from 'node:path';

/** @param {import('@sveltejs/kit').Builder} builder */
function signInAssets(builder) {
  /** @type {import('vite').Manifest} */
  const manifest = JSON.parse(readFileSync(`${builder.getClientDirectory()}/.vite/manifest.json`, 'utf8'));
  const generated = relative('.', `${builder.getBuildDirectory('generated')}/build/client-optimized`).replaceAll('\\', '/');
  const nodes = `${generated}/nodes`;
  const leaf = readdirSync(nodes).filter((/** @type {string} */ file) =>
    /^\d+\.js$/.test(file) && readFileSync(`${nodes}/${file}`, 'utf8').includes('/src/routes/sign-in/+page.svelte'));
  const start = Object.keys(manifest).find((key) => key.endsWith('/@sveltejs/kit/src/runtime/client/entry.js'));
  const runtime = start && manifest[start]?.dynamicImports?.find((key) => key.endsWith('/client-entry.js'));
  if (!start || !runtime || leaf.length !== 1) throw new Error('Could not locate sign-in client entries');
  const assets = new Set();
  const visited = new Set();
  /** @param {string} key */
  function include(key) {
    if (visited.has(key)) return;
    const entry = manifest[key];
    if (!entry) throw new Error(`Missing sign-in dependency: ${key}`);
    visited.add(key);
    for (const file of [entry.file, ...entry.css ?? [], ...entry.assets ?? []]) {
      if (!file.startsWith(`${builder.getAppPath()}/immutable/`) || !/^[\w./-]+\.(?:js|css|woff2)$/.test(file)) {
        throw new Error(`Unexpected sign-in asset: ${file}`);
      }
      assets.add(`/${file}`);
    }
    entry.imports?.forEach(include);
  }
  // Hydration needs both root nodes. Do not follow the app entry's dynamic imports.
  [start, runtime, `${generated}/app.js`, ...['0.js', '1.js', leaf[0]].map(file => `${nodes}/${file}`)].forEach(include);
  return [...assets];
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
      // The adapter can answer before the hook. Only the sign-in fixture can
      // fetch the page's exact generated assets; env.js remains unconditionally closed.
      writeFileSync(resolve(config.assets.directory, '_worker.js'), `
import adapterWorker from '../cloudflare-tmp/adapter-worker.js';
import { admitsSignInFixture, allowsOrigin } from '../../src/lib/server/request-auth.ts';
import { signIn } from '../../src/lib/server/sign-in.ts';

const appPath = ${JSON.stringify(`/${builder.getAppPath()}`)};
const signInAssets = new Set(${JSON.stringify(signInAssets(builder))});
const signInStep = /^\\/api\\/sign-in\\/(challenge|restart|verify)$/;
const unavailable = () => new Response('Service unavailable', {
  status: 503,
  headers: { 'cache-control': 'no-store' }
});
const unavailableAssets = { fetch: unavailable };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return unavailable();
    }
    if (admitsSignInFixture(env)) {
      const step = signInStep.exec(url.pathname)?.[1];
      if (step) return signIn(request, step, env);
      if (signInAssets.has(url.pathname) && env.ASSETS &&
          (request.method === 'GET' || request.method === 'HEAD') && allowsOrigin(request, env.DRIVE_ORIGIN)) {
        const asset = await env.ASSETS.fetch(request);
        const response = new Response(asset.body, asset);
        response.headers.set('cache-control', 'private, no-store');
        return response;
      }
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
