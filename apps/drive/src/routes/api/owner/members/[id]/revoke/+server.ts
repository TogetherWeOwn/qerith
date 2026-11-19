import { Membership } from '../../../../../../lib/server/identity/membership';
import { ownerAction, ownerReply, ownerResourceId } from '../../../../../../lib/server/owner-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const POST: RequestHandler = event => ownerAction(event, async (db, token) => {
  const { id } = event.params;
  if (!ownerResourceId.test(id)) return ownerReply(404);
  const membership = new Membership(db);
  const member = await membership.get(token, id);
  if (member?.status !== 'active') return ownerReply(404);
  return ownerReply(await membership.setStatus(token, id, member.generation, 'revoked') ? 204 : 404);
});
