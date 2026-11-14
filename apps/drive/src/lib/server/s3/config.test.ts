import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateConfig } from './config.ts';

const config = {
  endpoint: 'https://s3.example.test', bucket: 'drive-data', region: 'test-1',
  accessKeyId: 'test-access', secretAccessKey: 'test-secret',
};

test('accepts HTTPS and explicitly enabled loopback HTTP fixtures', () => {
  assert.equal(validateConfig(config).endpoint, 'https://s3.example.test');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(validateConfig({ ...config, endpoint: `http://${host}:9000`, allowLocalHttp: true }).endpoint, `http://${host}:9000`);
  }
});

test('rejects unsafe endpoints and invalid buckets', () => {
  for (const endpoint of [
    'http://localhost:9000', 'http://example.test', 'https://user:pass@example.test',
    'https://example.test/path', 'https://example.test/tenant/..', 'https://example.test/%2e',
    'https://example.test?x=1', 'https://example.test#fragment',
  ]) assert.throws(() => validateConfig({ ...config, endpoint }), /Invalid S3 endpoint/);
  assert.throws(() => validateConfig({ ...config, endpoint: 'http://example.test', allowLocalHttp: true }));
  for (const bucket of ['UPPER', 'ab', 'bad..name', '192.168.1.1', 'bad/name']) {
    assert.throws(() => validateConfig({ ...config, bucket }), /Invalid S3 configuration/);
  }
  for (const field of ['region', 'accessKeyId', 'secretAccessKey'] as const) {
    assert.throws(() => validateConfig({ ...config, [field]: '  ' }), /Invalid S3 configuration/);
  }
});
