import { DOMParser } from '@xmldom/xmldom';
import { createS3Transport } from './transport';

const namespace = 'http://s3.amazonaws.com/doc/2006-03-01/';
const xmlChars = /^[\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]*$/u;

function uploadIdFromResponse(body: Uint8Array): string {
  const invalid = (): never => { throw new Error('Invalid multipart create response'); };
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return invalid(); }
  // Mask CDATA and comments in one pass so malformed openers cannot cause rescans.
  let markup = '';
  let position = 0;
  while (position < xml.length) {
    const start = xml.indexOf('<!', position);
    if (start < 0) { markup += xml.slice(position); break; }
    markup += xml.slice(position, start);
    const cdata = xml.startsWith('<![CDATA[', start);
    const comment = xml.startsWith('<!--', start);
    if (!cdata && !comment) return invalid();
    const content = start + (cdata ? 9 : 4);
    const end = xml.indexOf(cdata ? ']]>' : '-->', content);
    if (end < 0 || (comment && (xml.slice(content, end).includes('--') || xml[end - 1] === '-'))) return invalid();
    markup += cdata ? 'CDATA' : ' ';
    position = end + 3;
  }
  if (!xmlChars.test(xml) || markup.includes(']]>') || /<!|<\?(?!xml\s)/i.test(markup) || /&(?!(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));)/.test(markup)) return invalid();
  // Only XML whitespace is valid between tag names and delimiters.
  for (const tag of markup.match(/<[^>]*>/g) ?? []) {
    if (/[^\x00-\x7f]/.test(tag)) return invalid();
  }
  for (const match of markup.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);/g)) {
    const code = match[1].startsWith('x') ? parseInt(match[1].slice(1), 16) : Number(match[1]);
    if (!Number.isSafeInteger(code) || code > 0x10ffff || !xmlChars.test(String.fromCodePoint(code))) return invalid();
  }
  const declaration = /^[\x20\x09\x0a\x0d]*(?:<\?xml[\x20\x09\x0a\x0d]+version[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(['"])1\.0\1(?:[\x20\x09\x0a\x0d]+encoding[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(['"])[Uu][Tt][Ff]-8\2)?(?:[\x20\x09\x0a\x0d]+standalone[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(['"])(?:yes|no)\3)?[\x20\x09\x0a\x0d]*\?>)?/;
  const content = markup.replace(declaration, '');
  if (!/^[\x20\x09\x0a\x0d]*<((?:[A-Za-z_][\w.-]*:)?InitiateMultipartUploadResult)(?:[\x20\x09\x0a\x0d]+xmlns(?::[A-Za-z_][\w.-]*)?[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(?:"[^"]*"|'[^']*'))*[\x20\x09\x0a\x0d]*>[\s\S]*<\/\1[\x20\x09\x0a\x0d]*>[\x20\x09\x0a\x0d]*$/.test(content)) return invalid();
  let document: Document;
  try {
    document = new DOMParser({ onError: () => { throw new Error('Invalid XML'); } }).parseFromString(xml.trimStart(), 'application/xml') as unknown as Document;
  } catch { return invalid(); }
  const root = document.documentElement;
  if (!root || root.localName !== 'InitiateMultipartUploadResult' || !['', namespace].includes(root.namespaceURI ?? '') || (root.prefix && !root.namespaceURI)) return invalid();
  const onlyNamespaces = (element: Element) => Array.from(element.attributes).every((attribute) => attribute.namespaceURI === 'http://www.w3.org/2000/xmlns/');
  const values = new Map<string, string>();
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 8 || (node.nodeType === 3 && /^[\x20\x09\x0a\x0d]*$/.test(node.nodeValue ?? ''))) continue;
    if (node.nodeType !== 1) return invalid();
    const element = node as Element;
    if (!['Bucket', 'Key', 'UploadId'].includes(element.localName) || values.has(element.localName) || !onlyNamespaces(element) || (element.namespaceURI ?? '') !== (root.namespaceURI ?? '') || (element.prefix && !element.namespaceURI)) return invalid();
    let value = '';
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 8) continue;
      if (child.nodeType !== 3 && child.nodeType !== 4) return invalid();
      value += child.nodeValue ?? '';
    }
    values.set(element.localName, value);
  }
  const id = values.get('UploadId');
  if (!id || !xmlChars.test(id)) return invalid();
  return id;
}

/** Initiate once; an uncertain outcome may have allocated an upload. */
export function createMultipartCreate(...args: Parameters<typeof createS3Transport>) {
  const request = createS3Transport(...args);
  return async (key: string, signal?: AbortSignal) => {
    if (!key || key.split('/').some((segment) => segment === '.' || segment === '..')) throw new Error('Invalid S3 object key');
    try { encodeURIComponent(key); } catch { throw new Error('Invalid S3 object key'); }
    if (signal?.aborted) throw new Error('S3 request cancelled');
    let response: Awaited<ReturnType<typeof request>>;
    try { response = await request({ method: 'POST', key, query: { uploads: '' }, signal, maxResponseBytes: 64 * 1024 }); }
    catch { throw new Error('S3 multipart create allocation uncertain'); }
    if (response.status === 200) {
      try { return { uploadId: uploadIdFromResponse(response.body) }; }
      catch { throw new Error('S3 multipart create allocation uncertain'); }
    }
    if (response.status === 408 || response.status >= 500 || (response.status >= 200 && response.status < 300)) throw new Error('S3 multipart create allocation uncertain');
    throw new Error(`S3 request failed with status ${response.status}`);
  };
}
