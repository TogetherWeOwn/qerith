import { DOMParser } from '@xmldom/xmldom';
import { AwsClient } from 'aws4fetch';

export default {
  async fetch(): Promise<Response> {
    const parse = (input: string) => {
      const document = new DOMParser({
        onError: (level, message) => { throw new Error(`${level}: ${message}`); }
      }).parseFromString(input, 'application/xml');
      if (document.doctype) throw new Error('DOCTYPE is forbidden');
      return document;
    };
    if (parse('<root>A &amp; B</root>').documentElement.textContent !== 'A & B') {
      throw new Error('XML entity decoding failed');
    }
    for (const input of ['<root><item></root>', '<!DOCTYPE root><root/>', '<root>&unknown;</root>']) {
      let rejected = false;
      try { parse(input); } catch { rejected = true; }
      if (!rejected) throw new Error('Invalid XML was accepted');
    }
    const client = new AwsClient({ accessKeyId: 'test-key', secretAccessKey: 'test-secret', service: 's3', region: 'us-east-1' });
    const signed = await client.sign('https://example.invalid/bucket/object');
    if (!signed.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 Credential=test-key/')) {
      throw new Error('Request was not signed');
    }
    return new Response('runtime-ok');
  }
};
