import { Invitations } from '../../../../../../lib/server/identity/invitations';
import { ownerAction, ownerReply, ownerResourceId } from '../../../../../../lib/server/owner-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const POST: RequestHandler = event => ownerAction(event, async (db, token) => {
  if (!ownerResourceId.test(event.params.id)) return ownerReply(404);
  await new Invitations(db).cancel(token, event.params.id);
  return ownerReply(204);
});
