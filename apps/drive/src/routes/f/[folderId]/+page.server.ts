import type { PageServerLoad } from './$types';
import { folderPage } from '../../../lib/server/folder-page';

export const load: PageServerLoad = async ({ request, params, setHeaders }) => {
  setHeaders({ 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' });
  // The session integration must explicitly supply dependencies before reads are possible.
  return { result: await folderPage(request, params.folderId) };
};
