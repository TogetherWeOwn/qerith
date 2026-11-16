export const rpID = 'example.test';
export const origin = `https://${rpID}`;
export const challenge = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const decode = (value: string) => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => Array.from(part)));
const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);
const cborBytes = (value: Uint8Array) => join(value.length < 24 ? bytes(0x40 + value.length) : bytes(0x58, value.length), value);
const cborText = (value: string) => join(bytes(0x60 + value.length), text(value));

// Web Crypto returns P1363 ECDSA signatures, while WebAuthn uses DER.
function der(raw: Uint8Array) {
  const integer = (value: Uint8Array) => {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) start++;
    value = value.slice(start);
    return join(bytes(2, value.length + (value[0] >> 7)), value[0] & 0x80 ? bytes(0) : bytes(), value);
  };
  const body = join(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return join(bytes(0x30, body.length), body);
}

export async function fixture(kind: 'registration' | 'authentication', options: { origin?: string; rpID?: string; uv?: boolean; badSignature?: boolean; crossOrigin?: boolean; topOrigin?: string } = {}) {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
  const cose = join(bytes(0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20), decode(jwk.x!), bytes(0x22, 0x58, 0x20), decode(jwk.y!));
  const id = bytes(1, 2, 3, 4);
  const clientData = text(JSON.stringify({ type: kind === 'registration' ? 'webauthn.create' : 'webauthn.get', challenge, origin: options.origin ?? origin, crossOrigin: options.crossOrigin, topOrigin: options.topOrigin }));
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', text(options.rpID ?? rpID)));
  const flags = (options.uv === false ? 0x01 : 0x05) | (kind === 'registration' ? 0x40 : 0);
  const authData = join(rpHash, bytes(flags, 0, 0, 0, 1), ...(kind === 'registration' ? [new Uint8Array(16), bytes(0, id.length), id, cose] : []));
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientData));
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, join(authData, clientHash)));
  if (options.badSignature) raw[0] ^= 1;
  const signature = der(raw);
  const common = { id: encode(id), rawId: encode(id), type: 'public-key' as const, clientExtensionResults: {} };
  const registration = { ...common, response: { clientDataJSON: encode(clientData), attestationObject: encode(join(
    bytes(0xa3), cborText('fmt'), cborText('packed'), cborText('authData'), cborBytes(authData),
    cborText('attStmt'), bytes(0xa2), cborText('alg'), bytes(0x26), cborText('sig'), cborBytes(signature),
  )) } };
  const authentication = { ...common, response: { clientDataJSON: encode(clientData), authenticatorData: encode(authData), signature: encode(signature) } };
  return { registration, authentication, credential: { id: encode(id), publicKey: cose, counter: 0 } };
}
