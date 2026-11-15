import { DOMParser } from '@xmldom/xmldom';

const MAX_RESPONSE_BYTES = 64 * 1024;
const S3_NAMESPACE = 'http://s3.amazonaws.com/doc/2006-03-01/';
const XML_CHARS = /^[\u0009\u000a\u000d -퟿-�\u{10000}-\u{10ffff}]*$/u;

export type MultipartCompletionResponse =
  | { kind: 'success'; etag: string; bucket?: string; key?: string; location?: string; checksums?: Record<string, string> }
  | { kind: 'error'; code: string; message?: string; requestId?: string; hostId?: string };

/** Parse an already bounded transport body. A thrown error means completion is uncertain. */
export function parseMultipartCompletionResponse(body: Uint8Array): MultipartCompletionResponse {
  const invalid = () => { throw new Error('Invalid S3 multipart completion response'); };
  if (body.byteLength > MAX_RESPONSE_BYTES) return invalid();
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(body); } catch { return invalid(); }
  if (!XML_CHARS.test(xml)) return invalid();
  // Only XML 1.0 is supported; S3 may send XML whitespace before the declaration.
  const source = xml.replace(/^[\x20\x09\x0a\x0d]+/, '');
  if (/^<\?xml(?=[\x20\x09\x0a\x0d?])/.test(source) &&
      !/^<\?xml[\x20\x09\x0a\x0d]+version[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(['"])1\.0\1(?:[\x20\x09\x0a\x0d]+encoding[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(['"])[Uu][Tt][Ff]-8\2)?(?:[\x20\x09\x0a\x0d]+standalone[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(['"])(?:yes|no)\3)?[\x20\x09\x0a\x0d]*\?>/.test(source)) return invalid();
  // xmldom can discard non-XML whitespace after the document element.
  if (!/<\/(?:CompleteMultipartUploadResult|Error)[\x20\x09\x0a\x0d]*>[\x20\x09\x0a\x0d]*$/.test(source)) return invalid();
  // Preserve boundaries when excluding CDATA: a terminator spanning nodes is valid.
  const ordinary: string[] = [];
  let offset = 0;
  while (true) {
    const start = source.indexOf('<![CDATA[', offset);
    if (start < 0) { ordinary.push(source.slice(offset)); break; }
    ordinary.push(source.slice(offset, start));
    const end = source.indexOf(']]>', start + 9);
    if (end < 0) return invalid();
    offset = end + 3;
  }
  if (ordinary.some((part) => part.includes(']]>'))) return invalid();
  // Do not let the XML parser accept non-XML whitespace within tag markup.
  for (const part of ordinary) {
    let position = 0;
    while (true) {
      const start = part.indexOf('<', position);
      if (start < 0) break;
      const end = part.indexOf('>', start + 1);
      if (end < 0) return invalid();
      const tag = part.slice(start, end + 1);
      position = end + 1;
      if (tag.startsWith('<?xml') && source.startsWith(tag)) continue;
      if (!/^<\/?[A-Za-z][A-Za-z0-9]*(?:[\x20\x09\x0a\x0d]+xmlns[\x20\x09\x0a\x0d]*=[\x20\x09\x0a\x0d]*(?:"http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/"|'http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/'))?[\x20\x09\x0a\x0d]*\/?>$/.test(tag)) return invalid();
    }
  }
  const references = ordinary.join(' ');
  if (/<!DOCTYPE/i.test(references)) return invalid();
  if (/&(?!(?:amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));)/.test(references)) return invalid();
  for (const match of references.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);/g)) {
    const number = match[1].startsWith('x') ? Number.parseInt(match[1].slice(1), 16) : Number(match[1]);
    if (!Number.isSafeInteger(number) || number > 0x10ffff || !XML_CHARS.test(String.fromCodePoint(number))) return invalid();
  }
  let document: Document;
  try {
    document = new DOMParser({ normalizeLineEndings: (input) => input.replace(/\r\n?/g, '\n'), onError: (level, message) => {
      if (level === 'warning' && message === 'Unicode replacement character detected, source encoding issues?') return;
      throw new Error('Invalid XML');
    } }).parseFromString(source, 'application/xml') as unknown as Document;
  } catch { return invalid(); }
  const root = document.documentElement;
  if (!root || document.doctype || !['CompleteMultipartUploadResult', 'Error'].includes(root.tagName) ||
      !['', S3_NAMESPACE].includes(root.namespaceURI ?? '')) return invalid();
  for (const node of Array.from(document.childNodes)) {
    if (node !== root && !(node.nodeType === 7 && node.nodeName === 'xml') &&
        !(node.nodeType === 3 && /^[\x20\x09\x0a\x0d]*$/.test(node.nodeValue ?? ''))) return invalid();
  }
  for (const attr of Array.from(root.attributes)) {
    if (attr.name !== 'xmlns' || attr.value !== S3_NAMESPACE) return invalid();
  }
  const checksumFields = ['ChecksumCRC32', 'ChecksumCRC32C', 'ChecksumCRC64NVME', 'ChecksumSHA1', 'ChecksumSHA256', 'ChecksumType'];
  const allowed = root.tagName === 'Error'
    ? ['Code', 'Message', 'RequestId', 'HostId']
    : ['ETag', 'Bucket', 'Key', 'Location', ...checksumFields];
  const values = new Map<string, string>();
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 3 && /^[\x20\x09\x0a\x0d]*$/.test(node.nodeValue ?? '')) continue;
    if (node.nodeType !== 1) return invalid();
    const element = node as Element;
    if (!allowed.includes(element.tagName) || values.has(element.tagName) || element.attributes.length ||
        (element.namespaceURI ?? '') !== (root.namespaceURI ?? '')) return invalid();
    let value = '';
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType !== 3 && child.nodeType !== 4) return invalid();
      value += child.nodeValue ?? '';
    }
    if (!XML_CHARS.test(value)) return invalid();
    values.set(element.tagName, value);
  }
  if (root.tagName === 'Error') {
    const code = values.get('Code');
    if (!code || !code.trim()) return invalid();
    return { kind: 'error', code, message: values.get('Message'), requestId: values.get('RequestId'), hostId: values.get('HostId') };
  }
  const etag = values.get('ETag');
  if (!etag || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) return invalid();
  const checksums = Object.fromEntries(checksumFields.filter((field) => values.has(field)).map((field) => [field, values.get(field)!]));
  return { kind: 'success', etag, bucket: values.get('Bucket'), key: values.get('Key'), location: values.get('Location'),
    ...(Object.keys(checksums).length ? { checksums } : {}) };
}
