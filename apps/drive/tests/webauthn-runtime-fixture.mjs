import { verifyAuthenticationResponse } from '@simplewebauthn/server';

const encode = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = (value) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
const join = (...parts) => Uint8Array.from(parts.flatMap((part) => Array.from(part)));

// Web Crypto produces P1363 ECDSA signatures; WebAuthn assertions use ASN.1 DER.
function derSignature(raw) {
  const integer = (bytes) => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    const value = bytes.slice(start);
    return join([0x02, value.length + (value[0] >> 7)], value[0] & 0x80 ? [0] : [], value);
  };
  const body = join(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return join([0x30, body.length], body);
}

async function exercise() {
  const rpID = 'example.test';
  const origin = `https://${rpID}`;
  const challenge = encode(crypto.getRandomValues(new Uint8Array(32)));
  const credentialID = encode(crypto.getRandomValues(new Uint8Array(32)));
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', key.publicKey);
  const coseKey = join([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20], decode(publicKey.x), [0x22, 0x58, 0x20], decode(publicKey.y));
  const clientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpID)));
  const authenticatorData = join(rpHash, [0x05, 0, 0, 0, 1]);
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, join(authenticatorData, clientHash)));
  const response = {
    id: credentialID,
    rawId: credentialID,
    type: 'public-key',
    response: { authenticatorData: encode(authenticatorData), clientDataJSON: encode(clientData), signature: encode(derSignature(signature)) },
    clientExtensionResults: {},
  };
  const options = { response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, credential: { id: credentialID, publicKey: coseKey, counter: 0 }, requireUserVerification: true };
  const positive = await verifyAuthenticationResponse(options);
  if (!positive.verified || positive.authenticationInfo.newCounter !== 1) throw new Error('Valid assertion was not verified');
  let rejected = false;
  try {
    await verifyAuthenticationResponse({ ...options, expectedChallenge: encode(new Uint8Array(32)) });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('Incorrect challenge was not rejected');
}

export default {
  async fetch() {
    try {
      await exercise();
      return new Response('webauthn-runtime-ok');
    } catch (error) {
      console.error(error);
      return new Response('webauthn-runtime-failed', { status: 500 });
    }
  },
};
