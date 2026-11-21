import { reconcilePrivateObjectDeletions } from './metadata/private-object-deletion';
import type { S3Config } from './s3/config';
import { createS3ObjectDeleter } from './s3/private-object-deleter';
import { storageIdentity, type StorageBindings } from './storage-runtime';

type Database = Parameters<typeof reconcilePrivateObjectDeletions>[0];
type DeleteOptions = Parameters<typeof createS3ObjectDeleter>[2];
type Fixture = Required<Pick<DeleteOptions, 'fetch' | 'confirmsRemoval'>> & Pick<DeleteOptions, 'now'>;

/** Server composition only. A provider-specific rule, not a request value or an upload qualification. */
export type PrivateDeletionQualification = Readonly<{
  storageConfigId: string;
  region: string;
  confirmsRemoval: NonNullable<DeleteOptions['confirmsRemoval']>;
}>;

export function bindPrivateDeletionStorage(db: Database, env: StorageBindings, qualification: PrivateDeletionQualification) {
  const identity = storageIdentity(env);
  if (!identity || typeof db.withSession !== 'function') return null;
  const { settings, epoch, storageConfigId } = identity;
  const { storageConfigId: qualifiedId, region, confirmsRemoval } = qualification;
  if (qualifiedId !== storageConfigId || region !== settings.region || typeof confirmsRemoval !== 'function') return null;
  const resolve = createS3ObjectDeleter(settings, epoch, {
    fetch: (input, init) => fetch(input, init), confirmsRemoval, timeoutMs: 5000
  });
  return {
    settings, epoch,
    reconcile: (deletionId: string) => reconcilePrivateObjectDeletions(db, resolve, { deletionId }),
    drain: () => reconcilePrivateObjectDeletions(db, resolve)
  };
}

/** Fixtures must inject both transport and removal proof. */
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
