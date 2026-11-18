import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
// Node executes this build configuration; Node type declarations are not app dependencies.
// @ts-ignore
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
// @ts-ignore
import { resolve } from 'node:path';

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
      // Both the adapter and SvelteKit can answer asset requests before the app hook.
      // Deny the generated namespace (including env.js) and direct asset fetches.
      writeFileSync(resolve(config.assets.directory, '_worker.js'), `
import adapterWorker from '../cloudflare-tmp/adapter-worker.js';

const appPath = ${JSON.stringify(`/${builder.getAppPath()}`)};
const unavailable = () => new Response('Service unavailable', {
  status: 503,
  headers: { 'cache-control': 'no-store' }
});
const unavailableAssets = { fetch: unavailable };

export default {
  fetch(request, env, ctx) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return unavailable();
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
