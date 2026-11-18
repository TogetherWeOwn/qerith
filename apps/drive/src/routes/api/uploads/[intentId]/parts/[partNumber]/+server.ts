import { uploadPart } from '../../../../../../lib/server/upload-part';
import type { RequestHandler } from './$types';

// No live session or part claim adapter is wired to the deployed app.
export const PUT: RequestHandler = ({ request, params }) =>
  uploadPart(request, params.intentId, params.partNumber);
