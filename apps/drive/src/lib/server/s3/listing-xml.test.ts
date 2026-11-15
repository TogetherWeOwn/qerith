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

test('preserves XML 1.0 Unicode text while normalizing CR and CRLF', () => {
  const root = parseListingXml(bytes('<Result><Key>a\u0085b c d\re\r\nf&#13;g</Key></Result>'), 'Result');
  assert.equal(listingText(root, 'Key'), 'a\u0085b c d\ne\nf\rg');
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

test('rejects illegal character data and trailing non-XML whitespace', () => {
  for (const xml of ['<Result><Key>bad]]>text</Key></Result>', '<Result/> ', ' <Result/>', '<Result/> <!--x-->', '<!--x--> <Result/>']) {
    assert.throws(() => parseListingXml(bytes(xml), 'Result'), /^Error: Invalid S3 listing XML$/);
  }
  const root = parseListingXml(bytes('<Result attr="]]>"><Key><![CDATA[]]>]]&gt;</Key></Result> \r\n'), 'Result');
  assert.equal(listingText(root, 'Key'), ']]>');
});

test('accepts a large valid page of maximum-length keys', () => {
  const contents = `<Contents><Key>${'a'.repeat(1024)}</Key></Contents>`.repeat(1000);
  const root = parseListingXml(bytes(`<ListBucketResult>${contents}</ListBucketResult>`), 'ListBucketResult');
  assert.equal(listingChildren(root, 'Contents').length, 1000);
});

test('bounds markup and attribute allocation before DOM parsing', () => {
  for (const xml of [
    `<Result>${'<a/>'.repeat(50_000)}</Result>`,
    `<Result>${'<!--x-->'.repeat(50_000)}</Result>`,
    `<Result${' a="x"'.repeat(50_000)}/>`
  ]) assert.throws(() => parseListingXml(bytes(xml), 'Result'), /^Error: Invalid S3 listing XML$/);
  const attributes = Array.from({ length: 100_000 }, (_, i) => `\u0080a${i}="x"`).join('');
  assert.throws(() => parseListingXml(bytes(`<Result${attributes}/>`), 'Result'), /^Error: Invalid S3 listing XML$/);
  const valid = parseListingXml(bytes('<Result attr="\u0080"><Key>\u0080</Key></Result>'), 'Result');
  assert.equal(listingText(valid, 'Key'), '\u0080');
  const root = parseListingXml(bytes(`<Result><Key><![CDATA[${'<a/>'.repeat(50_000)}]]></Key></Result>`), 'Result');
  assert.equal(listingText(root, 'Key')?.length, 200_000);
});

test('bounds nesting before parsing and accepts shallow listings', () => {
  const nested = (count: number) => `<Result>${'<x xmlns="urn:x">'.repeat(count)}${'</x>'.repeat(count)}</Result>`;
  assert.throws(() => parseListingXml(bytes(nested(64)), 'Result'), /^Error: Invalid S3 listing XML$/);
  assert.ok(parseListingXml(bytes(nested(63)), 'Result'));
});

test('accepts only XML 1.0 with UTF-8 declarations', () => {
  for (const declaration of ['<?xml version="1.1"?>', '<?xml version="1.0" encoding="UTF-16"?>']) {
    assert.throws(() => parseListingXml(bytes(`${declaration}<Result/>`), 'Result'), /^Error: Invalid S3 listing XML$/);
  }
  assert.ok(parseListingXml(bytes('<?xml version="1.0" encoding="utf-8" standalone="yes"?><Result/>'), 'Result'));
});

test('rejects collapsed expanded attributes and reserved namespace bindings', () => {
  for (const input of [
    '<Result xmlns:a="urn:x" xmlns:b="urn:x" a:id="1" b:id="2"/>',
    '<Result><x xmlns:xml="urn:wrong"/></Result>',
    '<Result xmlns:p="http://www.w3.org/XML/1998/namespace"/>',
    '<Result xmlns="http://www.w3.org/2000/xmlns/"/>',
    '<Result xmlns:xmlns="urn:x"/>',
    '<Result xmlns:p=""/>'
  ]) assert.throws(() => parseListingXml(bytes(input), 'Result'), /^Error: Invalid S3 listing XML$/);
  assert.ok(parseListingXml(bytes('<Result xmlns:xml="http://www.w3.org/XML/1998/namespace" xmlns:a="urn:a" xmlns:b="urn:b" a:id="1" b:id="2"><x xmlns=""/></Result>'), 'Result'));
});

test('rejects repeated unterminated markup prefixes', () => {
  for (const prefix of ['<!--', '<![CDATA[', '<?']) {
    const input = bytes(`<Result>${prefix.repeat(100_000)}</Result>`);
    assert.throws(() => parseListingXml(input, 'Result'), /^Error: Invalid S3 listing XML$/);
  }
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
