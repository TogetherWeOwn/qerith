import assert from 'node:assert/strict';
import test from 'node:test';
import { driveNext, isDrivePageNavigation } from '../src/lib/drive-navigation';

const pages = ['/', '/f/folder-1', '/shared', '/shared/f/folder_2', '/people'];
const nonPages = ['/sign-in', '/invite/token', '/recovery', '/api/download/id', '/_app/env.js', '/favicon.ico', '/unknown'];
const query = '?sort=modified&dir=desc&page=opaque%2Ftoken&find=Project+notes&tag=a%23b&tag=c';

test('retains only canonical Drive paths and preserves ordinary query strings', () => {
  for (const path of pages) {
    assert.equal(driveNext(path), path);
    assert.equal(driveNext(path + query), path + query);
  }
  const location = driveNext('/people?find=会議&filter=A%2FB');
  assert.equal(new Headers({ location }).get('location'), '/people?find=%E4%BC%9A%E8%AD%B0&filter=A%2FB');
  for (const value of [null, '', ...nonPages, 'f/folder', 'https://drive.example/f/folder', '//example.test/f/folder',
    '/f/', '/shared/', '/f/a/b', '/shared//f/a', '/f/..', '/f/./a', '/x/../people', '/f/a\\b', '/\\example.test',
    '/f/a%2fb', '/f/a%5Cb', '/f/a%252fb', '/f/%2e%2e', '/f/%61', '/f/%', '/f/a?bad=%XX',
    '/people#', '/f/a?q=1#frag', '/f/a\n', '/pe\tople', ' /people']) {
    assert.equal(driveNext(value), '/', JSON.stringify(value));
  }
});

test('classifies only explicit GET or HEAD Drive document navigations without range or preconditions', () => {
  const metadata = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' };
  const request = (path = '/', method = 'GET', headers: HeadersInit = metadata) =>
    new Request(`https://drive.example${path}`, { method, headers });
  for (const path of pages) assert.equal(isDrivePageNavigation(request(path + query)), true, path);
  assert.equal(isDrivePageNavigation(request('/people', 'HEAD', { ...metadata, 'sec-fetch-site': 'none' })), true);
  for (const path of nonPages) assert.equal(isDrivePageNavigation(request(path)), false, path);
  assert.equal(isDrivePageNavigation(request('/', 'POST')), false);
  for (const [name, value] of Object.entries({
    'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site',
  })) {
    const headers = new Headers(metadata);
    headers.delete(name);
    assert.equal(isDrivePageNavigation(request('/', 'GET', headers)), false, `missing ${name}`);
    headers.set(name, value);
    assert.equal(isDrivePageNavigation(request('/', 'GET', headers)), false, `${name}: ${value}`);
  }
  for (const name of ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since']) {
    assert.equal(isDrivePageNavigation(request('/', 'GET', { ...metadata, [name]: '' })), false, name);
  }
});
