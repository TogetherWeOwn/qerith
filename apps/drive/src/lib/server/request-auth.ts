import { Sessions } from './identity/sessions';

export interface DriveAuthEnv {
  DRIVE_ORIGIN?: string;
  DB?: ConstructorParameters<typeof Sessions>[0];
}

export const sessionCookie = '__Host-drive-session';

export function authOrigin(value?: string): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? url : null;
  } catch {
    return null;
  }
}

export function allowsOrigin(request: Request, origin: string): boolean {
  if (new URL(request.url).origin !== origin) return false;
  const source = request.headers.get('origin');
  return source === origin || (source === null && (request.method === 'GET' || request.method === 'HEAD'));
}

function readSessionCookie(request: Request): string | null {
  let token: string | null = null;
  for (const cookie of (request.headers.get('cookie') ?? '').split(';')) {
    const pair = cookie.trimStart();
    if (!pair.startsWith(`${sessionCookie}=`)) continue;
    const value = pair.slice(sessionCookie.length + 1);
    if (token !== null || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
    token = value;
  }
  return token;
}

export async function readSession(request: Request, db: NonNullable<DriveAuthEnv['DB']>) {
  const token = readSessionCookie(request);
  if (token === null) return null;
  // Use the primary binding and re-read membership on every private request.
  const principal = await new Sessions(db).lookup(token);
  return principal === null ? null : { principal, token };
}
