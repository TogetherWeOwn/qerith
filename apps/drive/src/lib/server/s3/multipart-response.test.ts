import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMultipartCompletionResponse as parse } from './multipart-response.ts';

const bytes = (xml: string) => new TextEncoder().encode(xml);

test('parses a namespaced completion without normalizing opaque values', () => {
  assert.deepEqual(parse(bytes('<?xml version="1.0"?><CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket> b </Bucket><Key>a&amp;b/中</Key><ETag>&quot;a&amp;b&quot;</ETag><Location> https://example.test/ </Location></CompleteMultipartUploadResult>')), {
    kind: 'success', etag: '"a&b"', bucket: ' b ', key: 'a&b/中', location: ' https://example.test/ '
  });
});

test('distinguishes embedded error documents from successful completions', () => {
  assert.deepEqual(parse(bytes('<Error><Code> InternalError </Code><Message>try &amp; retry</Message><RequestId> x </RequestId></Error>')), {
    kind: 'error', code: ' InternalError ', message: 'try & retry', requestId: ' x ', hostId: undefined
  });
});

test('accepts keepalive whitespace, checksums, literal CDATA, and replacement characters', () => {
  assert.deepEqual(parse(bytes(' \n\t<?xml version="1.0"?><CompleteMultipartUploadResult><ETag>"e"</ETag><Key><![CDATA[a&b<!DOCTYPE-report]]>�</Key><ChecksumCRC32> 123 </ChecksumCRC32><ChecksumType>COMPOSITE</ChecksumType></CompleteMultipartUploadResult>')), {
    kind: 'success', etag: '"e"', bucket: undefined, key: 'a&b<!DOCTYPE-report�', location: undefined,
    checksums: { ChecksumCRC32: ' 123 ', ChecksumType: 'COMPOSITE' }
  });
  assert.equal(parse(bytes('<Error><Code>&#65533;</Code></Error>')).kind, 'error');
});

test('rejects malformed, ambiguous, and unsupported documents', () => {
  for (const xml of [
    '', '<CompleteMultipartUploadResult/>', '<Error/>', '<Error><Code> </Code></Error>',
    '<CompleteMultipartUploadResult><ETag>abc</ETag></CompleteMultipartUploadResult>',
    '<CompleteMultipartUploadResult><ETag>"a"</ETag><ETag>"b"</ETag></CompleteMultipartUploadResult>',
    '<Error><Code>x</Code><Code>y</Code></Error>', '<Error><Code><x/></Code></Error>',
    '<Error><Code>&unknown;</Code></Error>', '<Error><Code>&#0;</Code></Error>',
    '<Error><Code>a&b</Code></Error>', '<Error><Code>&amp</Code></Error>',
    '<Error><Code>&#4294967297;</Code></Error>', '<Error><Code>&#x110000;</Code></Error>',
    '<Error><Code>&#xD800;</Code></Error>', '<Error><Code>�&bad;</Code></Error>',
    '<CompleteMultipartUploadResult><ETag>"a"</ETag><ChecksumSHA256>x</ChecksumSHA256><ChecksumSHA256>y</ChecksumSHA256></CompleteMultipartUploadResult>',
    '<Error><Code>x</Error>', '<!DOCTYPE Error [<!ENTITY x "a">]><Error><Code>&x;</Code></Error>',
    '<Error xmlns="urn:other"><Code>x</Code></Error>', '<Error><Code xmlns="urn:other">x</Code></Error>',
    '<Error><Code>x</Code><Other>y</Other></Error>', '<Error><Code>x</Code></Error><Error><Code>y</Code></Error>',
    '<Error><Code>x</Code></Error>trailing', '<Error><Code>x</Code><!-- hidden --></Error>'
  ]) assert.throws(() => parse(bytes(xml)), /Invalid S3 multipart completion response/, xml);
  assert.throws(() => parse(new Uint8Array([0xff])));
  assert.throws(() => parse(new Uint8Array(64 * 1024 + 1)));
});
