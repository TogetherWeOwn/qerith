export const ownerResourceId = /^[A-Za-z0-9_-]{1,512}$/;

const invitations = '/api/owner/invitations';

// Match the raw request to the endpoint SvelteKit is allowed to resolve in staging.
export function ownerLifecycleRoute(request: Request, { origin, pathname, search }: URL): string | null {
  if (request.url !== origin + pathname + search) return null;
  if (pathname === invitations && request.method === 'GET') {
    return !search || (search.startsWith('?after=') && ownerResourceId.test(search.slice(7))) ? invitations : null;
  }
  if (request.method !== 'POST' || search) return null;
  if (pathname === invitations) return invitations;
  const [, api, owner, resource, id, action, extra] = pathname.split('/', 7);
  if (api !== 'api' || owner !== 'owner' || !id || !ownerResourceId.test(id) || extra !== undefined) return null;
  if (resource === 'invitations' && action === 'cancel') return `${invitations}/[id]/cancel`;
  if (resource === 'members' && action === 'revoke') return '/api/owner/members/[id]/revoke';
  return null;
}
