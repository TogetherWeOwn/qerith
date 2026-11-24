import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ownerStorageFetch, ownerStorageOrigin } from './public-egress';
import { createS3Transport } from './transport';

const drive = 'https://drive.example.com';
const config = { endpoint: 'https://objects.example.com', bucket: 'files', region: 'us-east-1',
  accessKeyId: 'synthetic-key', secretAccessKey: 'synthetic-secret' };

test('the effective public authority is also the signed S3 destination for both addressing styles', async () => {
  for (const pathStyle of [true, false]) {
    const settings = { ...config, pathStyle };
    const origin = ownerStorageOrigin(settings, drive);
    const hostname = pathStyle ? 'objects.example.com' : 'files.objects.example.com';
    const calls: number[] = [];
    let sent = 0;
    const send: typeof fetch = async input => {
      assert.ok(input instanceof Request);
      const url = new URL(input.url);
      if (url.hostname === 'cloudflare-dns.com') {
        assert.equal(url.searchParams.get('name'), hostname);
        assert.equal(input.redirect, 'manual');
        assert.ok(!input.headers.has('authorization'));
        const type = Number(url.searchParams.get('type'));
        calls.push(type);
        return Response.json({ Status: 0, Question: [{ name: `${hostname}.`, type }],
          Answer: [{ type, data: type === 1 ? '93.184.216.34' : '2606:4700::1111' }] });
      }
      assert.equal(url.hostname, hostname);
      assert.equal(url.pathname, pathStyle ? '/files/folder/key' : '/folder/key');
      assert.match(input.headers.get('authorization') ?? '', /SignedHeaders=host;/);
      assert.equal(input.redirect, 'manual');
      sent++;
      return new Response(null, { status: 204 });
    };
    const transport = ownerStorageFetch(origin, send);
    await transport.prepare();
    const request = createS3Transport(settings, { fetch: transport.fetch, timeoutMs: 5000 });
    for (const method of ['HEAD', 'DELETE'] as const) await request({ method, key: 'folder/key', maxResponseBytes: 0 });
    assert.deepEqual(calls.sort(), [1, 28]);
    assert.equal(sent, 2);
  }
});

test('private, reserved, mixed DNS answers and non-DNS destinations are rejected before S3', async () => {
  for (const endpoint of ['http://objects.example.com', 'https://0x7f000001', 'https://[::1]',
    'https://intranet.local', 'https://x.home.arpa', 'https://drive.example.com:443']) {
    assert.throws(() => ownerStorageOrigin({ ...config, endpoint }, drive));
  }
  for (const [recordType, bad] of [[1, '169.254.169.254'], [1, '10.2.3.4'], [1, '100.64.0.1'], [1, '192.168.1.2'],
    [1, '127.0.0.1'], [28, '::ffff:7f00:1'], [28, 'fc00::1'], [28, 'fe80::1'], [28, '2002:a01::1'],
    [5, 'internal.local.']] as const) {
    const request = ownerStorageFetch(config.endpoint, async input => {
      assert.ok(input instanceof Request);
      const url = new URL(input.url);
      assert.equal(url.hostname, 'cloudflare-dns.com');
      const type = Number(url.searchParams.get('type'));
      const Answer = type === 28 ? [] : [{ type, data: '93.184.216.34' }];
      if (type === recordType || recordType === 5) Answer.push({ type: recordType, data: bad });
      return Response.json({ Status: 0, Question: [{ name: 'objects.example.com.', type }], Answer });
    });
    await assert.rejects(request.prepare(), /Storage DNS denied/);
    await assert.rejects(request.fetch(new Request(config.endpoint, { redirect: 'manual' })), /Storage DNS unavailable/);
    await assert.rejects(request.fetch(new Request('https://elsewhere.example.com', { redirect: 'manual' })), /Storage destination denied/);
  }
});
