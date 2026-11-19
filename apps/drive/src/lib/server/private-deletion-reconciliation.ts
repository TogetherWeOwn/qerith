import { reconcilePrivateObjectDeletions } from './metadata/private-object-deletion';
import type { S3Config } from './s3/config';
import { createS3ObjectDeleter } from './s3/private-object-deleter';

type Database = Parameters<typeof reconcilePrivateObjectDeletions>[0];
type DeleteOptions = Parameters<typeof createS3ObjectDeleter>[2];
type Fixture = Required<Pick<DeleteOptions, 'fetch' | 'confirmsRemoval'>> & Pick<DeleteOptions, 'now'>;

/** Closed in normal composition. Fixtures must inject both transport and removal proof. */
export function createPrivateDeletionReconciler(db: Database, config: S3Config, epoch: string,
  fixture?: Fixture): ((deletionId: string) => Promise<number>) | null {
  if (!fixture) return null;
  const { fetch, confirmsRemoval, now } = fixture;
  if (typeof fetch !== 'function' || typeof confirmsRemoval !== 'function') return null;
  const resolve = createS3ObjectDeleter(config, epoch, { fetch, confirmsRemoval, now, timeoutMs: 5000 });
  // Only pass the internal UUID returned by the authorized ledger mutation.
  return (deletionId) => reconcilePrivateObjectDeletions(db, resolve, { deletionId });
}
