import { DOMParser } from '@xmldom/xmldom';

type ListingElement = NonNullable<ReturnType<DOMParser['parseFromString']>['documentElement']>;

const MAX_XML_BYTES = 8 * 1024 * 1024;
const S3_NAMESPACE = 'http://s3.amazonaws.com/doc/2006-03-01/';

function xmlCharacter(value: number): boolean {
  return value === 9 || value === 10 || value === 13 ||
    (value >= 0x20 && value <= 0xd7ff) || (value >= 0xe000 && value <= 0xfffd) ||
    (value >= 0x10000 && value <= 0x10ffff);
}

function validateCharactersAndReferences(xml: string): void {
  for (const character of xml) {
    if (!xmlCharacter(character.codePointAt(0)!)) throw new Error();
  }
  // Entity references are not interpreted inside comments, CDATA, or processing instructions.
  const content = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, ' ');
  for (let index = content.indexOf('&'); index !== -1; index = content.indexOf('&', index + 1)) {
    const reference = /^(?:&(amp|lt|gt|apos|quot);|&#([0-9]+);|&#x([0-9a-fA-F]+);)/.exec(content.slice(index));
    if (!reference) throw new Error();
    if ((reference[2] || reference[3]) &&
        !xmlCharacter(parseInt(reference[2] || reference[3], reference[2] ? 10 : 16))) throw new Error();
    index += reference[0].length - 1;
  }
}

/** Parse a bounded S3 listing response without exposing provider input in errors. */
export function parseListingXml(bytes: Uint8Array, rootName: string): ListingElement {
  if (bytes.byteLength > MAX_XML_BYTES) throw new Error('Invalid S3 listing XML');
  try {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    validateCharactersAndReferences(xml);
    const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE/gi;
    for (const match of xml.matchAll(markup)) {
      if (/^<!DOCTYPE/i.test(match[0])) throw new Error();
    }
    const document = new DOMParser({ onError: (level, message) => {
      // Fatal UTF-8 decoding above already distinguishes valid U+FFFD from invalid bytes.
      if (level !== 'warning' || message !== 'Unicode replacement character detected, source encoding issues?') {
        throw new Error();
      }
    } })
      .parseFromString(xml, 'application/xml');
    const root = document.documentElement;
    if (document.doctype || !root || root.localName !== rootName ||
        (root.namespaceURI && root.namespaceURI !== S3_NAMESPACE)) throw new Error();
    return root;
  } catch {
    throw new Error('Invalid S3 listing XML');
  }
}

/** Select direct children only; nested lookalike fields must not affect pagination. */
export function listingChildren(parent: ListingElement, name: string): ListingElement[] {
  const elements: ListingElement[] = [];
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const element = node as ListingElement;
      if (element.localName === name && element.namespaceURI === parent.namespaceURI) elements.push(element);
    }
  }
  return elements;
}

export function listingText(parent: ListingElement, name: string, required = true): string | undefined {
  const elements = listingChildren(parent, name);
  if (elements.length > 1 || (required && elements.length !== 1)) throw new Error('Invalid S3 listing XML');
  const element = elements[0];
  if (!element) return undefined;
  for (let node = element.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 3 && node.nodeType !== 4 && node.nodeType !== 7 && node.nodeType !== 8) {
      throw new Error('Invalid S3 listing XML');
    }
  }
  return element.textContent ?? '';
}
