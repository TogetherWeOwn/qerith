import { reconcilePrivateObjectDeletions } from './metadata/private-object-deletion';
import type { S3Config } from './s3/config';
import { createS3ObjectDeleter } from './s3/private-object-deleter';

type Database = Parameters<typeof reconcilePrivateObjectDeletions>[0];
type DeleteOptions = Parameters<typeof createS3ObjectDeleter>[2];
type Fixture = Required<Pick<DeleteOptions, 'fetch' | 'confirmsRemoval'>> & Pick<DeleteOptions, 'now'>;

/** Closed in normal composition. Fixtures must inject both transport and removal proof. */
function fixtureDeleter(config: S3Config, epoch: string, fixture?: Fixture) {
  if (!fixture) return null;
  const { fetch, confirmsRemoval, now } = fixture;
  if (typeof fetch !== 'function' || typeof confirmsRemoval !== 'function') return null;
  return createS3ObjectDeleter(config, epoch, { fetch, confirmsRemoval, now, timeoutMs: 5000 });
}

export function createPrivateDeletionReconciler(db: Database, config: S3Config, epoch: string,
  fixture?: Fixture): ((deletionId: string) => Promise<number>) | null {
  const resolve = fixtureDeleter(config, epoch, fixture);
  // Only pass the internal UUID returned by the authorized ledger mutation.
  return resolve && ((deletionId) => reconcilePrivateObjectDeletions(db, resolve, { deletionId }));
}

/** Fixture-only scheduled entry point: one bounded batch, with no request or trigger wiring. */
export function createPrivateDeletionDrain(db: Database, config: S3Config, epoch: string,
  fixture?: Fixture): (() => Promise<number>) | null {
  const resolve = fixtureDeleter(config, epoch, fixture);
  return resolve && (() => reconcilePrivateObjectDeletions(db, resolve));
}
