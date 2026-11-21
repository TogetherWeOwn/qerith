import { qualificationReceiptName } from './staging-qualification.mjs';

// No default transport or CLI: the protected caller must supply the uploader.
export function uploadQualificationReceipt({ env, evidence, status, cwd, signal, upload }) {
  const name = qualificationReceiptName(env, evidence, status, cwd);
  signal?.throwIfAborted();
  return upload({ name, signal });
}
