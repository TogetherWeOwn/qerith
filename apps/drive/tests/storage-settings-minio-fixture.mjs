import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { checkServerIdentity } from 'node:tls';
import { Agent, request as sendHttp } from 'undici'; // Locked by Wrangler.
import { withLocalMinio } from '../scripts/first-release-smoke-minio.mjs';
import { readBoundedBody } from '../src/lib/server/bounded-io.ts';

export const fixtureStorageEndpoint = 'https://drive-storage.example.com';

/** Miniflare's outbound service keeps the packaged Worker offline while MinIO verifies the original SigV4 Host. */
export async function withStorageSettingsMinio(dir, bucket, run) {
  await withLocalMinio(dir, bucket, async (minio) => {
    const ca = await readFile(join(dir, 'certs', 'public.crt'));
    const dispatcher = new Agent({ connect: { ca,
      // SigV4 uses the external fixture Host. TLS authenticates the pinned loopback server.
      checkServerIdentity: (_host, certificate) => checkServerIdentity('127.0.0.1', certificate),
    } });
    const config = { ...minio.settings, endpoint: fixtureStorageEndpoint, pathStyle: true };
    async function outbound(request, intercept = () => undefined) {
      const url = new URL(request.url);
      if (url.origin === 'https://cloudflare-dns.com') {
        const name = url.searchParams.get('name'), type = Number(url.searchParams.get('type'));
        if (url.pathname !== '/dns-query' || name !== new URL(fixtureStorageEndpoint).hostname ||
            (type !== 1 && type !== 28) || request.headers.has('authorization')) throw new Error('Unexpected DNS fixture request');
        return Response.json({ Status: 0, Question: [{ name: `${name}.`, type }],
          Answer: type === 1 ? [{ type, data: '93.184.216.34' }] : [] });
      }
      if (url.origin !== fixtureStorageEndpoint || !url.pathname.startsWith(`/${bucket}/`) ||
          !request.headers.has('authorization')) throw new Error('Unexpected S3 fixture request');
      const intercepted = await intercept(request);
      if (intercepted) return intercepted;
      const headers = new Headers(request.headers);
      headers.set('host', url.host);
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(8000)]);
      const body = request.body && await readBoundedBody(request.body, { signal, maxBytes: 16 * 1024 * 1024, timeoutMs: 5000 });
      if (request.body && !body) throw new Error('Unexpected S3 fixture body');
      const response = await sendHttp(minio.settings.endpoint + url.pathname + url.search, {
        method: request.method, headers: [...headers].flat(), body: body ?? undefined, signal, dispatcher,
      });
      const returned = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) returned.set(name, String(value));
      }
      const status = response.statusCode;
      const hasBody = request.method !== 'HEAD' && status !== 204 && status !== 304;
      if (!hasBody) await response.body.dump();
      return new Response(hasBody ? Readable.toWeb(response.body) : null, { status, headers: returned });
    }
    try { await run({ config, outbound, minio }); }
    finally { await dispatcher.destroy(); }
  });
}
