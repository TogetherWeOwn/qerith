import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createAnnouncer } from './announcements';

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const updates: string[][] = [];
  let modal = false;
  const announcer = createAnnouncer((...messages) => updates.push(messages), () => modal);
  return { ...announcer, updates, elapsed: () => t.mock.timers.tick(200), modal(open: boolean) { modal = open; } };
}

test('coalesces duplicate feedback, keeps urgency, and repeats a later action', t => {
  const { scope, updates, elapsed } = fixture(t);
  const upload = scope(), listing = scope(), duplicate = scope();
  upload.announce('Uploading');
  upload.announce('Upload interrupted', 'assertive');
  upload.announce('Upload interrupted', 'assertive');
  duplicate.announce('Upload interrupted');
  listing.announce('Folder created');
  elapsed();
  upload.announce('Upload interrupted', 'assertive');
  elapsed();
  assert.deepEqual(updates, [['', ''], ['Folder created', 'Upload interrupted'], ['', ''], ['', 'Upload interrupted']]);
});

test('defers while a native modal is active and clears pending feedback on navigation', t => {
  const { scope, updates, elapsed, modal, clear, resume } = fixture(t);
  const listing = scope();
  listing.announce('Folder created');
  modal(true);
  elapsed();
  assert.deepEqual(updates, [['', '']]);
  modal(false);
  resume();
  elapsed();
  assert.deepEqual(updates.at(-1), ['Folder created', '']);
  listing.announce('Stale message');
  clear();
  elapsed();
  listing.announce('Discard on unmount');
  listing.dispose();
  listing.announce('Late response', 'assertive');
  elapsed();
  assert.deepEqual(updates.slice(2), [['', ''], ['', ''], ['', '']]);
});
