import { json } from '@sveltejs/kit';
import { Invitations } from '../../../../lib/server/identity/invitations';
import { ownerAction, ownerReply, readInviteMetadata } from '../../../../lib/server/owner-routes';
import type { RequestHandler } from './$types';

export const trailingSlash = 'ignore';

export const GET: RequestHandler = event => ownerAction(event, async (db, token) =>
  json({ invitations: await new Invitations(db).list(token) }));

export const POST: RequestHandler = event => ownerAction(event, async (db, token) => {
  const metadata = await readInviteMetadata(event.request);
  if (!metadata) return ownerReply(400);
  return json(await new Invitations(db).issue(token, metadata), { status: 201 });
});
