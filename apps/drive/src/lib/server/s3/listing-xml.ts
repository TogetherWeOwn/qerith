import { DOMParser } from '@xmldom/xmldom';

type ListingElement = NonNullable<ReturnType<DOMParser['parseFromString']>['documentElement']>;

const MAX_XML_BYTES = 8 * 1024 * 1024;
const S3_NAMESPACE = 'http://s3.amazonaws.com/doc/2006-03-01/';

/** Parse a bounded S3 listing response without exposing provider input in errors. */
export function parseListingXml(bytes: Uint8Array, rootName: string): ListingElement {
  if (bytes.byteLength > MAX_XML_BYTES) throw new Error('Invalid S3 listing XML');
  try {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const markup = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE/gi;
    for (const match of xml.matchAll(markup)) {
      if (/^<!DOCTYPE/i.test(match[0])) throw new Error();
    }
    const document = new DOMParser({ onError: () => { throw new Error(); } })
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
    if (node.nodeType !== 3 && node.nodeType !== 4) throw new Error('Invalid S3 listing XML');
  }
  return element.textContent ?? '';
}
