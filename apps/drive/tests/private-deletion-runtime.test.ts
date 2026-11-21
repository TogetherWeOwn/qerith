import assert from 'node:assert/strict';
import test from 'node:test';
import { bindPrivateDeletionStorage, type PrivateDeletionQualification } from '../src/lib/server/private-deletion-reconciliation';

const bindings = {
  DRIVE_S3_ENDPOINT: 'https://STORAGE.example.test:443/', DRIVE_S3_BUCKET: 'drive-fixture',
  DRIVE_S3_REGION: 'auto', DRIVE_S3_STORAGE_EPOCH: 'fixture-epoch',
  DRIVE_S3_ACCESS_KEY_ID: 'fixture', DRIVE_S3_SECRET_ACCESS_KEY: 'fixture'
};
const qualified: PrivateDeletionQualification = {
  storageConfigId: '["https://storage.example.test","drive-fixture","fixture-epoch"]',
  region: 'auto', confirmsRemoval: () => { throw new Error('Qualification must not run during binding'); }
};
const db = { withSession() { throw new Error('Binding must not touch D1'); } };

test('deletion binds only a qualified normalized runtime storage namespace', () => {
  const binding = bindPrivateDeletionStorage(db, bindings, qualified);
  assert.equal(binding?.settings.endpoint, 'https://storage.example.test');
  assert.equal(binding?.settings.bucket, 'drive-fixture');
  assert.equal(binding?.epoch, 'fixture-epoch');
  for (const overrides of [
    { DRIVE_S3_ENDPOINT: 'https://other.example.test' }, { DRIVE_S3_BUCKET: 'other-fixture' },
    { DRIVE_S3_STORAGE_EPOCH: undefined }, { DRIVE_S3_STORAGE_EPOCH: 'other-epoch' },
    { DRIVE_S3_REGION: 'other' }, { DRIVE_S3_ACCESS_KEY_ID: undefined },
  ]) assert.equal(bindPrivateDeletionStorage(db, { ...bindings, ...overrides }, qualified), null);
});
