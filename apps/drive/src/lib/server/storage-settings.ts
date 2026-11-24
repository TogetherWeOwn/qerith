import { livePrincipalCheck, tokenHash } from './identity/sessions';
import { readMetadataJson } from './metadata-request';
import { firstReleaseOrigin, usesOwnerStorage, type QualificationReadinessEnv } from './qualification-readiness';
import { allowsOrigin, allowsStagingInviteSite, readSession } from './request-auth';
import { validateConfig, type S3Config } from './s3/config';
import { ownerStorageFetch, ownerStorageOrigin } from './s3/public-egress';
import { verifyStorageSettings } from './storage-settings-probe';
import type { UploadRouteEnv } from './upload-routes';

type Database = NonNullable<UploadRouteEnv['DB']>;
export interface StorageSettingsEnv extends QualificationReadinessEnv {
  DB?: Database;
  DRIVE_STORAGE_SETTINGS_KEY?: string;
}

type Settings = S3Config & { pathStyle: boolean };
type Row = { revision: string; storage_epoch: string; nonce: string; ciphertext: string };
type Saved = { revision: string; epoch: string; config: Readonly<Settings> };

export const storageSettingsPath = '/api/owner/storage';
export const storageTestPath = `${storageSettingsPath}/test`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const now = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
const activeOwner = `EXISTS (SELECT 1 FROM drive_sessions s JOIN drive_principals p ON p.id = s.principal_id
  WHERE s.token_hash = ? AND p.id = ? AND p.role = 'owner' AND p.status = 'active' AND s.expires_at > ${now})`;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const headers = { 'cache-control': 'private, no-store' };
const error = (status: number, code: string) => Response.json({ error: code }, { status, headers });

function settings(value: Record<string, unknown>, origin: string, secret: unknown): Readonly<Settings> {
  const { endpoint, bucket, region, accessKeyId, pathStyle } = value;
  if (typeof endpoint !== 'string' || endpoint.length > 512 || /[^\x21-\x7e]/.test(endpoint) ||
      typeof bucket !== 'string' || typeof region !== 'string' || region.length > 64 ||
      typeof accessKeyId !== 'string' || accessKeyId.length > 256 || typeof pathStyle !== 'boolean' ||
      typeof secret !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(secret)) throw new Error('Invalid storage settings');
  const config = Object.freeze({ ...validateConfig({ endpoint, bucket, region, accessKeyId, secretAccessKey: secret, pathStyle }), pathStyle });
  ownerStorageOrigin(config, origin);
  return config;
}

function sameLocation(a: Settings, b: Settings) {
  return a.endpoint === b.endpoint && a.bucket === b.bucket && a.region === b.region && a.pathStyle === b.pathStyle;
}

function publicSettings(saved: Saved | null) {
  if (!saved) return { status: 'unconfigured', revision: null, config: null };
  const { endpoint, region, bucket, accessKeyId, pathStyle } = saved.config;
  return { status: 'connected', revision: saved.revision, config: { endpoint, region, bucket, accessKeyId, pathStyle } };
}

async function storageKey(value: unknown): Promise<CryptoKey> {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value)) throw new Error('Storage key unavailable');
  return crypto.subtle.importKey('raw', Uint8Array.fromBase64(value, { alphabet: 'base64url' }), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function associatedData(origin: string, revision: string, epoch: string) {
  return encoder.encode(JSON.stringify(['drive-storage-settings-v1', origin, revision, epoch]));
}

export async function readSavedStorage(env: StorageSettingsEnv): Promise<Saved | null> {
  const origin = firstReleaseOrigin(env);
  if (!env.DB || !origin) throw new Error('Storage settings unavailable');
  const row = await env.DB.withSession('first-primary').prepare(`SELECT revision, storage_epoch, nonce, ciphertext
    FROM drive_storage_settings WHERE singleton = 1`).first<Row>();
  if (!row) return null;
  const { revision, storage_epoch: epoch, nonce, ciphertext } = row;
  if (!uuid.test(revision) || !uuid.test(epoch) || !/^[a-f0-9]{24}$/.test(nonce) ||
      !/^(?:[a-f0-9]{2}){16,4096}$/.test(ciphertext)) throw new Error('Storage settings unavailable');
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.fromHex(nonce),
    additionalData: associatedData(origin, revision, epoch) }, await storageKey(env.DRIVE_STORAGE_SETTINGS_KEY), Uint8Array.fromHex(ciphertext));
  const value = JSON.parse(decoder.decode(bytes));
  return { revision, epoch, config: settings(value, origin, value.secretAccessKey) };
}

async function readInput(request: Request): Promise<Record<string, unknown> | null> {
  const input = await readMetadataJson(request, { uniqueFields: true });
  if (!input || Object.keys(input).some(key => !['revision', 'endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'pathStyle'].includes(key)) ||
      (input.revision !== null && (typeof input.revision !== 'string' || !uuid.test(input.revision)))) return null;
  return input;
}

export async function ownerStorageSettings(request: Request, env: StorageSettingsEnv): Promise<Response> {
  const origin = firstReleaseOrigin(env), db = env.DB;
  if (!origin || !db || !usesOwnerStorage(env)) return new Response(null, { status: 404, headers });
  const url = new URL(request.url);
  const test = url.pathname === storageTestPath;
  if (request.url !== url.origin + url.pathname || (url.pathname !== storageSettingsPath && !test)) {
    return new Response(null, { status: 404, headers });
  }
  if (!allowsOrigin(request, origin) || !allowsStagingInviteSite(request)) return error(403, 'forbidden');
  try {
    const session = await readSession(request, db);
    if (!session) return error(401, 'unauthorized');
    if (session.principal.role !== 'owner') return error(403, 'forbidden');
    if (test ? request.method !== 'POST' : request.method !== 'GET' && request.method !== 'PUT') {
      return new Response(null, { status: 405, headers: { ...headers, allow: test ? 'POST' : 'GET, PUT' } });
    }
    const saved = await readSavedStorage(env);
    if (request.method === 'GET') return Response.json(publicSettings(saved), { headers });
    const input = await readInput(request);
    if (!input) return error(400, 'invalid_settings');
    if (input.revision !== (saved?.revision ?? null)) return error(409, 'settings_conflict');
    let config;
    try {
      config = settings(input, origin, Object.hasOwn(input, 'secretAccessKey') ? input.secretAccessKey : saved?.config.secretAccessKey);
    } catch { return error(400, 'invalid_settings'); }
    if (saved && !sameLocation(saved.config, config)) return error(409, 'storage_location_locked');
    // An upgraded database with storage-bound data needs an explicit migration to owner-managed storage.
    if (!saved && await db.withSession('first-primary').prepare('SELECT 1 FROM drive_upload_storage_bindings LIMIT 1').first()) {
      return error(409, 'storage_location_locked');
    }
    const key = await storageKey(env.DRIVE_STORAGE_SETTINGS_KEY);
    const principal = session.principal.id;
    const hash = await tokenHash(session.token);
    const lease = crypto.randomUUID();
    const acquired = await db.prepare(`INSERT INTO drive_storage_probe (singleton, lease, expires_at)
      SELECT 1, ?, ${now} + 30000 WHERE ${activeOwner}
      ON CONFLICT(singleton) DO UPDATE SET lease = excluded.lease, expires_at = excluded.expires_at
      WHERE drive_storage_probe.expires_at <= ${now} RETURNING lease`).bind(lease, hash, principal).first();
    if (!acquired) return error(409, 'settings_conflict');
    const liveOwner = livePrincipalCheck(db, 'owner', session.token, principal)!;
    try {
      // Check revision again under the probe lease before any outbound request.
      const latest = await readSavedStorage(env);
      if ((latest?.revision ?? null) !== input.revision) return error(409, 'settings_conflict');
      try {
        await verifyStorageSettings(config, ownerStorageFetch(ownerStorageOrigin(config, origin)), request.signal, liveOwner);
      } catch { return error(422, 'connection_failed'); }
      if (request.signal.aborted || !await liveOwner()) return error(403, 'forbidden');
      if (test) return Response.json({ status: 'verified' }, { headers });

      const revision = crypto.randomUUID(), epoch = saved?.epoch ?? crypto.randomUUID();
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
        additionalData: associatedData(origin, revision, epoch) }, key, encoder.encode(JSON.stringify(config))));
      const ownsLease = `EXISTS (SELECT 1 FROM drive_storage_probe WHERE singleton = 1 AND lease = ? AND expires_at > ${now})`;
      if (request.signal.aborted) return error(403, 'forbidden');
      const stored = saved
        ? await db.prepare(`UPDATE drive_storage_settings SET revision = ?, nonce = ?, ciphertext = ?
            WHERE singleton = 1 AND revision = ? AND ${activeOwner} AND ${ownsLease} RETURNING revision`)
          .bind(revision, nonce.toHex(), ciphertext.toHex(), saved.revision, hash, principal, lease).first()
        : await db.prepare(`INSERT INTO drive_storage_settings (singleton, revision, storage_epoch, nonce, ciphertext)
            SELECT 1, ?, ?, ?, ? WHERE ${activeOwner} AND ${ownsLease}
            AND NOT EXISTS (SELECT 1 FROM drive_upload_storage_bindings LIMIT 1)
            ON CONFLICT(singleton) DO NOTHING RETURNING revision`)
          .bind(revision, epoch, nonce.toHex(), ciphertext.toHex(), hash, principal, lease).first();
      return stored ? Response.json(publicSettings({ revision, epoch, config }), { headers }) : error(409, 'settings_conflict');
    } finally {
      await db.prepare('DELETE FROM drive_storage_probe WHERE singleton = 1 AND lease = ? RETURNING lease').bind(lease).first().catch(() => {});
    }
  } catch { return error(503, 'settings_unavailable'); }
}
