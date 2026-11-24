const storageApi = '/api/owner/storage';

export interface StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  pathStyle: boolean;
}

export type SavedStorage =
  | { status: 'unconfigured'; revision: null; config: null }
  | { status: 'connected'; revision: string; config: StorageConfig };

export function sameStorageLocation(saved: StorageConfig, draft: StorageConfig) {
  // The API returns the canonical origin and accepts a trailing slash on input.
  if (!/^https:\/\/[^/?#@\\\s]+\/?$/i.test(draft.endpoint)) return false;
  try {
    return new URL(draft.endpoint).origin === saved.endpoint && saved.region === draft.region &&
      saved.bucket === draft.bucket && saved.pathStyle === draft.pathStyle;
  } catch {
    return false;
  }
}

function readSettings(body: Record<string, unknown>): SavedStorage | undefined {
  if (body.status === 'unconfigured' && body.revision === null && body.config === null) {
    return { status: 'unconfigured', revision: null, config: null };
  }
  if (body.status !== 'connected' || typeof body.revision !== 'string' || !body.revision ||
      !body.config || typeof body.config !== 'object') return;
  const { endpoint, region, bucket, accessKeyId, pathStyle } = body.config as Record<string, unknown>;
  if (typeof endpoint !== 'string' || typeof region !== 'string' || typeof bucket !== 'string' ||
      typeof accessKeyId !== 'string' || typeof pathStyle !== 'boolean') return;
  return { status: 'connected', revision: body.revision, config: { endpoint, region, bucket, accessKeyId, pathStyle } };
}

type StorageFailure = 'denied' | 'invalid_settings' | 'settings_conflict' | 'storage_location_locked' |
  'connection_failed' | 'unavailable';

function storageFailure(status: number, code: unknown): StorageFailure {
  if (status === 401 || status === 403) return 'denied';
  if (status === 400 && code === 'invalid_settings') return code;
  if (status === 409 && (code === 'settings_conflict' || code === 'storage_location_locked')) return code;
  if (status === 422 && code === 'connection_failed') return code;
  return 'unavailable';
}

type StorageOperation = 'load' | 'test' | 'save';
type StorageResult = { settings: SavedStorage } | { verified: true } | { error: StorageFailure };

export async function requestStorageSettings(operation: StorageOperation,
  write?: StorageConfig & { revision: string | null; secretAccessKey?: string }): Promise<StorageResult> {
  try {
    const response = await fetch(operation === 'test' ? storageApi + '/test' : storageApi, {
      method: operation === 'load' ? 'GET' : operation === 'test' ? 'POST' : 'PUT',
      mode: 'same-origin', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      ...(write && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(write) }),
    });
    const body = response.headers.get('content-type')?.split(';')[0] === 'application/json'
      ? await response.json() as Record<string, unknown> | null : null;
    if (response.status !== 200) return { error: storageFailure(response.status, body?.error) };
    if (operation === 'test' && body?.status === 'verified') return { verified: true };
    const settings = body && readSettings(body);
    if (settings && (operation === 'load' || (operation === 'save' && settings.status === 'connected'))) return { settings };
  } catch {
    // Response text and network errors can contain sensitive provider details.
  }
  return { error: 'unavailable' };
}
