import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';

function parseStrict(input: string) {
  const document = new DOMParser({
    onError: (level, message) => { throw new Error(`${level}: ${message}`); }
  }).parseFromString(input, 'application/xml');
  if (document.doctype) throw new Error('DOCTYPE is forbidden');
  return document;
}

test('strict parser accepts predefined and numeric XML entities', () => {
  const document = parseStrict('<root>A &amp; B &#65; &#x42;</root>');
  assert.equal(document.documentElement.textContent, 'A & B A B');
});

for (const input of [
  '<root><item></root>',
  '<root>unterminated',
  '<root>&unknown;</root>',
  '<!DOCTYPE root><root/>',
  '<!DOCTYPE root [<!ENTITY x "value">]><root>&x;</root>',
  '<!DOCTYPE root [<!ENTITY x SYSTEM "file:///etc/passwd">]><root>&x;</root>'
]) {
  test(`strict parser rejects ${input}`, () => {
    assert.throws(() => parseStrict(input));
  });
}
