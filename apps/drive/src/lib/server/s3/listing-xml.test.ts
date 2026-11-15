import assert from 'node:assert/strict';
import test from 'node:test';
import { listingChildren, listingText, parseListingXml } from './listing-xml';

const bytes = (input: string) => new TextEncoder().encode(input);

test('reads direct listing fields with their text preserved', () => {
  const root = parseListingXml(bytes('<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Contents><Key> a/&amp;雪 </Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>'), 'ListBucketResult');
  assert.equal(listingText(listingChildren(root, 'Contents')[0], 'Key'), ' a/&雪 ');
  assert.equal(listingText(root, 'IsTruncated'), 'false');
  assert.equal(listingText(root, 'NextContinuationToken', false), undefined);
  const cdata = parseListingXml(bytes('<Result><!-- <!DOCTYPE ignored> --><Key><![CDATA[<!DOCTYPE notes]]></Key></Result>'), 'Result');
  assert.equal(listingText(cdata, 'Key'), '<!DOCTYPE notes');
  const mixed = parseListingXml(bytes('<?probe <!DOCTYPE ignored?><Result><Key>a<!-- comment -->b<?probe data?>c</Key></Result>'), 'Result');
  assert.equal(listingText(mixed, 'Key'), 'abc');
});

test('validates XML characters and references without rejecting literal replacement characters', () => {
  const root = parseListingXml(bytes('<Result><Key>�&#xFFFD;&#65533;<![CDATA[&bad;]]><!-- &bad; --><?p &bad;?></Key></Result>'), 'Result');
  assert.equal(listingText(root, 'Key'), '���&bad;');
  for (const value of ['&', '&amp', '&#;', '&#x;', '&#0;', '&#xD800;', '&#x110000;', '&#12x;', '\u0001', '￾']) {
    assert.throws(() => parseListingXml(bytes(`<Result><Key>${value}</Key></Result>`), 'Result'), /^Error: Invalid S3 listing XML$/);
  }
  assert.throws(() => parseListingXml(bytes('<Result attr="&amp"/>'), 'Result'), /^Error: Invalid S3 listing XML$/);
  assert.throws(() => parseListingXml(new Uint8Array([0x3c, 0x52, 0x2f, 0x3e, 0xef, 0xbf]), 'R'), /^Error: Invalid S3 listing XML$/);
});

test('accepts a large valid page of maximum-length keys', () => {
  const contents = `<Contents><Key>${'a'.repeat(1024)}</Key></Contents>`.repeat(1000);
  const root = parseListingXml(bytes(`<ListBucketResult>${contents}</ListBucketResult>`), 'ListBucketResult');
  assert.equal(listingChildren(root, 'Contents').length, 1000);
});

test('rejects malformed, oversized, non-UTF-8, foreign-root and DTD documents', () => {
  for (const input of [
    bytes('<ListBucketResult><x></ListBucketResult>'),
    bytes('<ListBucketResult>&unknown;</ListBucketResult>'),
    bytes('<!DOCTYPE ListBucketResult><ListBucketResult/>'),
    bytes('<Wrong/>'),
    bytes('<ListBucketResult xmlns="urn:other"/>'),
    new Uint8Array([0xff]),
    new Uint8Array(8 * 1024 * 1024 + 1)
  ]) assert.throws(() => parseListingXml(input, 'ListBucketResult'), /^Error: Invalid S3 listing XML$/);
});

test('rejects ambiguous fields and ignores nested or foreign lookalikes', () => {
  const root = parseListingXml(bytes('<Result><outer><Cursor>nested</Cursor></outer><Cursor xmlns="urn:other">foreign</Cursor><Cursor>one</Cursor></Result>'), 'Result');
  assert.equal(listingText(root, 'Cursor'), 'one');
  assert.throws(() => listingText(root, 'missing'));
  const duplicate = parseListingXml(bytes('<Result><Cursor>a</Cursor><Cursor>b</Cursor></Result>'), 'Result');
  assert.throws(() => listingText(duplicate, 'Cursor'));
  const nested = parseListingXml(bytes('<Result><Cursor><x/></Cursor></Result>'), 'Result');
  assert.throws(() => listingText(nested, 'Cursor'));
});
