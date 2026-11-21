import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { proveConditionalDelete } from './conditional-delete-proof.ts';
import { qualificationPrefix } from './staging-qualification.mjs';
import { runQualificationPhase } from './staging-qualification-worker.mjs';

const strongTag = /^"[\x21\x23-\x7e\x80-\xff]{1,254}"$/;
const token = value => typeof value === 'string' && value.length > 0;
const rejected = new Map([
  ['signed-out', 401], ['revoked', 401], ['non-owner', 404], ['missing-origin', 403], ['wrong-origin', 403],
  ['wrong-method', 405], ['invalid-id', 400], ['missing-confirmation', 400], ['invalid-confirmation', 400],
]);

// Unwired. Adapters must seed exclusively owned fixtures without overwriting
// and drain on abort. Inspect must independently project primary metadata (live
// entries in seed order), authoritative storage, journal fault hits and the complete
// scoped provider call/outcome trace (from provider replies, not job state).
// advanceRetryClock advances only the offline clock, not job rows or a live clock.
export async function exerciseQualificationDeletion(context, signal, io) {
  let phase = 'scope';
  try {
    const prefix = qualificationPrefix(context);
    assert.equal(context.prefix, prefix);
    const { endpoint, bucket, epoch } = io.scope;
    const url = new URL(endpoint);
    assert.ok(url.protocol === 'https:' && url.origin === endpoint && token(bucket) && token(epoch));
    const scope = Object.freeze({ endpoint, bucket, epoch });
    return await runQualificationPhase(async (_, active) => {
      const keyFor = name => `${prefix}delete-${name}`;
      const seed = async (name, count, chain, pinned = true) => {
        active.throwIfAborted();
        const ids = Array.from({ length: count }, () => randomUUID());
        const file = ids.at(-1);
        const entries = ids.map((id, i) => ({ id, parent: i ? ids[chain ? i - 1 : 0] : null, kind: id === file ? 'file' : 'folder' }));
        const key = keyFor(name);
        const { etag, revision } = await io.seed({ entries: structuredClone(entries), key, scope, pinned }, active);
        assert.ok(typeof etag === 'string' && strongTag.test(etag) && (pinned ? token(revision) : revision === null));
        return { entries, pinned, generation: { ...scope, key, etag, revision, entryId: file } };
      };
      const inspect = async (tree, removed = [], outcomes = [], faults = []) => {
        active.throwIfAborted();
        const { live, journal, job, publicationTombstoned, calls, object, journalFaults, now } =
          structuredClone(await io.inspect(structuredClone(tree), active));
        const { generation } = tree;
        const settled = outcomes.at(-1) === 'deleted';
        assert.deepEqual(journalFaults, faults);
        assert.deepEqual(live, tree.entries.filter(({ id }) => !removed.includes(id)));
        assert.deepEqual(journal.map(row => row.entryId).sort(), removed.toSorted());
        const deletionId = journal[0]?.deletionId;
        if (removed.length) assert.ok(token(deletionId) && journal.every(row => row.deletionId === deletionId));
        assert.deepEqual(calls, outcomes.map(outcome => ({ method: 'DELETE', key: generation.key,
          ifMatch: generation.etag, scope, outcome })));
        assert.equal(publicationTombstoned, removed.includes(generation.entryId));
        assert.deepEqual(object, settled ? { status: 404, code: 'NoSuchKey', key: generation.key, scope }
          : { status: 200, key: generation.key, etag: generation.etag, scope });
        if (!publicationTombstoned) assert.equal(job, null);
        else {
          assert.deepEqual(job.generation, generation);
          assert.equal(job.leaseToken, null);
          if (settled) assert.ok(Number.isSafeInteger(job.completedAt) && job.completedAt > 0 && token(job.completionToken));
          else assert.deepEqual([job.completedAt, job.completionToken], [null, null]);
        }
        return { deletionId, job, journal, now };
      };
      const remove = async (entryId, scenario, status) => {
        active.throwIfAborted();
        const res = await io.remove(entryId, scenario, active);
        assert.ok(res instanceof Response);
        const reader = res.body?.getReader();
        if (reader) {
          try { assert.equal((await reader.read()).done, true); }
          finally { await reader.cancel(); }
        }
        assert.deepEqual([res.status, res.headers.get('cache-control'), res.headers.get('allow')],
          [status, 'private, no-store', status === 405 ? 'POST' : null]);
      };
      const idsOf = tree => tree.entries.map(entry => entry.id);

      phase = 'delete-envelope';
      const tree = await seed('envelope', 3, true);
      await inspect(tree);
      for (const [scenario, status] of rejected) {
        await remove(scenario === 'invalid-id' ? 'invalid-id' : tree.entries[0].id, scenario, status);
        await inspect(tree);
      }
      await remove(tree.entries[0].id, 'owner', 202);
      await inspect(tree, idsOf(tree), ['deleted']);

      phase = 'delete-boundary-and-safe-fallback';
      for (const [axis, limit, chain] of [['count', 128, false], ['depth', 33, true]]) {
        for (const over of [false, true]) {
          const edge = await seed(`${axis}-${over ? 'over' : 'at'}`, limit + Number(over), chain);
          await inspect(edge);
          await remove(edge.entries[0].id, 'owner', over ? 404 : 202);
          if (over) {
            await inspect(edge);
            // The owner can explicitly select a bounded leaf; never truncate the rejected root operation.
            await remove(edge.generation.entryId, 'owner', 202);
          }
          await inspect(edge, over ? [edge.generation.entryId] : idsOf(edge), ['deleted']);
        }
      }
      const unpinned = await seed('unpinned', 2, true, false);
      await inspect(unpinned);
      await remove(unpinned.entries[0].id, 'owner', 404);
      await inspect(unpinned);

      phase = 'delete-rollback-and-retry';
      const recovery = await seed('recovery', 3, true);
      const root = recovery.entries[0].id;
      const faults = [{ operation: 'journal-insert', entryId: root }];
      await inspect(recovery);
      await remove(root, 'journal-failure', 503);
      await inspect(recovery, [], [], faults);

      const competing = await seed('competing', 1, false);
      await inspect(competing);
      const pending = (tree, hits) => inspect(tree, idsOf(tree), ['unconfirmed'], hits);
      await remove(competing.generation.entryId, 'provider-unconfirmed', 202);
      const other = await pending(competing);
      await remove(root, 'provider-unconfirmed', 202);
      const selected = await pending(recovery, faults);
      assert.notEqual(selected.deletionId, other.deletionId);
      for (const { job, now } of [selected, other]) {
        assert.ok(Number.isSafeInteger(now) && Number.isSafeInteger(job.availableAt) && job.availableAt > now);
      }
      const retryAt = Math.max(selected.job.availableAt, other.job.availableAt);
      const verifyEligible = async (tree, before, hits) => {
        assert.deepEqual(await pending(tree, hits), { ...before, now: retryAt });
      };
      active.throwIfAborted();
      await io.advanceRetryClock(retryAt, active);
      await verifyEligible(recovery, selected, faults);
      await verifyEligible(competing, other);
      active.throwIfAborted();
      await io.retry({ deletionId: selected.deletionId, generation: { ...recovery.generation } }, active);
      const settled = await inspect(recovery, idsOf(recovery), ['unconfirmed', 'deleted'], faults);
      assert.deepEqual(settled.journal, selected.journal);
      await verifyEligible(competing, other);

      phase = 'delete-provider-proof';
      active.throwIfAborted();
      const key = keyFor('provider-proof');
      const target = await io.seedProbe({ key, scope }, active);
      assert.deepEqual({ key: target.key, scope: target.scope }, { key, scope });
      const proof = await proveConditionalDelete({ ...target,
        request: operation => io.requestProbe({ ...operation, key, scope }),
        matchesBoundKey: reported => reported === key,
      }, active);
      assert.equal(proof.passed, true);
      return Object.fromEntries([...['delete-envelope', 'delete-boundary-and-safe-fallback', 'delete-rollback-and-retry'], phase]
        .map(name => [name, 'pass']));
    }, null, signal, 120_000);
  } catch {
    throw new Error(`Qualification deletion evidence is unverified (${phase}).`);
  }
}
