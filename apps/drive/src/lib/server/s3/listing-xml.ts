import { DOMParser } from '@xmldom/xmldom';

type ListingElement = NonNullable<ReturnType<DOMParser['parseFromString']>['documentElement']>;

const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_MARKUP_UNITS = 50_000;
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
  const reference = /(?:&(amp|lt|gt|apos|quot);|&#([0-9]+);|&#x([0-9a-fA-F]+);)/y;
  for (let index = 0; index < xml.length;) {
    const ending = xml.startsWith('<!--', index) ? '-->' : xml.startsWith('<![CDATA[', index) ? ']]>' : xml.startsWith('<?', index) ? '?>' : undefined;
    if (ending) {
      const end = xml.indexOf(ending, index + 2);
      if (end === -1) throw new Error();
      index = end + ending.length;
    } else if (xml[index] === '&') {
      reference.lastIndex = index;
      const match = reference.exec(xml);
      if (!match) throw new Error();
      if ((match[2] || match[3]) &&
          !xmlCharacter(parseInt(match[2] || match[3], match[2] ? 10 : 16))) throw new Error();
      index = reference.lastIndex;
    } else index++;
  }
}

/** Parse a bounded S3 listing response without exposing provider input in errors. */
export function parseListingXml(bytes: Uint8Array, rootName: string): ListingElement {
  if (bytes.byteLength > MAX_XML_BYTES) throw new Error('Invalid S3 listing XML');
  try {
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    validateCharactersAndReferences(xml);
    // xmldom accepts non-XML whitespace after the document element.
    const trailingWhitespace = />\s*$/.exec(xml)?.[0].slice(1);
    if (trailingWhitespace && /[^\x20\t\r\n]/.test(trailingWhitespace)) throw new Error();
    // Bound DOM nodes and attributes before parsing; whitespace runs bound attribute count.
    let markupUnits = 0;
    // The CDATA terminator is forbidden in character data, but allowed in attributes.
    for (let i = 0; i < xml.length;) {
      if (xml[i] !== '<') {
        const end = xml.indexOf('<', i);
        const textEnd = end === -1 ? xml.length : end;
        if (xml.slice(i, textEnd).includes(']]>')) throw new Error();
        i = textEnd;
      } else {
        if (++markupUnits > MAX_MARKUP_UNITS) throw new Error();
        const ending = xml.startsWith('<!--', i) ? '-->' : xml.startsWith('<![CDATA[', i) ? ']]>' : xml.startsWith('<?', i) ? '?>' : undefined;
        if (ending) {
          const end = xml.indexOf(ending, i + 2);
          if (end === -1) throw new Error();
          i = end + ending.length;
        } else {
          if (xml.slice(i, i + 9).toUpperCase() === '<!DOCTYPE') throw new Error();
          let quote = '';
          for (i++; i < xml.length; i++) {
            const c = xml[i];
            if (quote && c === quote) quote = '';
            else if (!quote && (c === '"' || c === "'")) quote = c;
            else if (!quote && c === '>') { i++; break; }
            // xmldom treats U+0080 as tag whitespace although XML 1.0 does not.
            else if (!quote && c === '\u0080') throw new Error();
            else if (!quote && /[\x20\t\r\n]/.test(c) && !/[\x20\t\r\n]/.test(xml[i - 1])) {
              if (++markupUnits > MAX_MARKUP_UNITS) throw new Error();
            }
          }
        }
      }
    }
    const document = new DOMParser({
      // XML 1.0 normalizes CR and CRLF, not the additional XML 1.1 line endings.
      normalizeLineEndings: (input) => input.replace(/\r\n?/g, '\n'),
      onError: (level, message) => {
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
