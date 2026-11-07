# Native encrypted-client protocol v1

`qerith_core::native` defines JSON wire types and deterministic validators. It
has no listener, catalogue implementation, scheduler, database, OPRF endpoint,
encryption implementation, or production profile registry. The engine pin is
unchanged. `tests/fixtures/native-v1.json` is the machine-readable golden corpus;
its **fixture-only** crypto/integrity names and short checksum are deliberately
not deployable profiles or evidence of encrypted content.

## Trust and version boundary

The transport authenticates the principal before passing a trusted `Owner` to
validation. A request's `scope` is compared to that owner, never used to establish
it. The `Authority` port resolves opaque scoped references under current grants;
its owned records are **trusted adapter inputs**, never deserialized from clients.
Missing and foreign references return the same public `not_authorized` code.
Debug formatting redacts opaque identifiers and all metadata. Errors contain only
a closed code, not echoed JSON, keys, filenames, provider messages or URLs.
Transport logs must not log serialized requests/responses or raw decoder errors.
Identifiers are not bearer credentials and must also be unguessable in adapters.

The bounded decoder accepts at most 65,536 bytes and rejects unknown fields,
unknown enum variants, duplicate struct fields, duplicate metadata keys and
malformed IDs. Adapters must enforce the same byte bound **before buffering**,
limit concurrency and time, and use these decoders rather than unbounded generic
JSON deserialization. Public Rust structs can be constructed directly; those
callers still invoke validators and must bound their own allocations.

Capability negotiation is v1 only. Clients offer an ordered list of profiles and
positive limits. Every profile requirement must be supported; unsupported entries
are not silently ignored. The first supported offered profile and exact requested
limits are selected, or the offer fails. Clients validate the entire selection,
including order/profile/version/limits, to reject downgrade. A scoped, expiring
session record pins that selection; every later call rechecks it against current
policy. There is no default plaintext or weaker-integrity path.

A deployment must supply independently accepted format, crypto and integrity
profile identifiers plus the exact lowercase full-ciphertext checksum length.
The validator checks declarations against that registry; it does not implement
a digest, validate envelopes cryptographically, prove plaintext exclusion, prove
possession, or trust a client's claim of encryption. Key and envelope fields are
references resolved as an owned pair, never inline keys or key material. OPRF
suite, convergent format, equality/dedupe scope, key lifecycle and authenticated
client decryption remain independently reviewed prerequisites. No universal
cross-tenant dedupe or provider-hosted transparent decryption is implied.

Limits are caller requests bounded by session and deployment policy, not prices
or trial promises. Structural ceilings are 1 PiB object length, 1,000 page entries,
one day per job, and 8 KiB metadata; deployments choose lower reviewed admission
limits. No byte payloads occur in control messages. Ciphertext transfers use
scoped handles and independently bounded transport bodies.

## Inventory and representation

| Native action | Shared REST/MCP semantic inventory | Contract |
|---|---|---|
| `capabilities` | capabilities | Version/profile/limits, no downgrade |
| `initiate_upload` | initiate upload | Authorized destination + create/replace condition + exact intent |
| `resume_upload` | upload-session continuation | Owned retained session, unchanged complete intent, received offset |
| `commit_upload` | commit upload | Same intent, complete trusted integrity receipt, atomic condition |
| `abort_upload` | abort upload | Explicit cancellation/committed/cleanup outcome, no remote erasure claim |
| `browse`, `stat` | paginated browse / stat | Authorized container or exact immutable generation |
| `download` | download authorization | Exact C/G, ciphertext range and length, scoped expiring handle |
| `restore` | restore | Exact G, bounded bytes/time, durable job handle |
| `status` | status/result | Owned durable job, monotonic byte progress and terminal result |
| `cancel` | cancel | Requested versus cancelled/committed/cleanup distinguished |

Copy/delete are shared operation-registry responsibilities, not a second native
implementation here. Adapters map these types once to the shared service; there
is no second persistence authority or experimental MCP task requirement.

`Ciphertext` binds **C**, exact ciphertext length, checksum, format/crypto/integrity
profile, key reference and envelope reference. `Target` separately binds logical
object to immutable **G**. C is an opaque identity, not a public equality oracle or
proof of possession. Metadata preserves UTF-8 values, key case and codepoint
sequences without normalization, including Content-Encoding. It is descriptive,
not permission to transform ciphertext. Serialization need not preserve JSON key
order or escape spelling; the actual metadata strings must remain exact.

`ByteRange` uses inclusive ciphertext offsets; require `first <= last < length`.
There are no plaintext-range or direct NNTP-seek semantics. A full-object checksum
in the object descriptor is never represented as a range digest. Transfer handle
redemption calls `validate_transfer`, which rechecks ownership, current access,
exact G/object/descriptor/range and expiry. An adapter pins a serving lease and
must not substitute latest G or a partially reconstructed cache object.

Cold restore follows explicit archival semantics: download authorization must
not secretly start a restore or imply that retained safety bytes are publicly
available. The adapter additionally checks restored availability and an intact
serving lease. Restore publication requires complete integrity-checked ciphertext
for this G; it cannot resurrect a deleted/overwritten logical reference. This
module validates the handle contract, not physical availability or archival proof.
R2 eviction still requires full exact-generation integrity/readability evidence
on two genuinely independent backbones; posting, STAT, elapsed time, samples and
two reseller labels never establish it.

## Upload, replay and commit obligations

All resume/commit/abort requests repeat the immutable intent (destination,
precondition, C/length/checksum/profile/key/envelope and metadata). The resolver
returns an owned upload receipt with expiration and received bytes. Resume returns
the authoritative offset, never a caller-asserted offset. Commit requires complete
bytes plus a **trusted** full-byte integrity receipt. That receipt is not proof
of correct encryption or two-backbone durability. Resume/commit reject an already
committed session; identical retained commit replay reconciles its result. Abort
can report already committed rather than claiming rollback.

`Authority::replay` is scoped to owner + request ID **across all operations** and
retains the complete typed action. A changed operation, argument or precondition
conflicts. Identical replay returns `Admission::Replay`, never permission to
execute again. It still reauthorizes current references. A new connection can use
a new compatible session to reconcile the same retained job/request. Typed action
equality ignores JSON property ordering but preserves exact metadata strings.

Validation alone cannot close TOCTOU races. The adapter must atomically claim the
request identity, persist its action/checkpoint/result, compare current G against
the create/replace condition, publish exactly one new immutable G and durable
work obligation, and commit the retained result in one transactional semantic
unit. Concurrent claim losers reconcile; they do not both execute. Recheck grants
and conditions at commit, not only before staging. Lost responses reconcile as
committed/absent/uncertain rather than blindly resubmitting a new upload. Handle,
cursor, job and replay retention/expiry must be published as deployment policy;
an expired request ID must not silently regain single-use authority. Old identity
tombstones or an equivalent non-reuse rule are required. No retention duration or
database has been selected here.

## Durable job and cancellation semantics

The wire has queued/running/succeeded/failed/cancelled, exact target G, declared
ciphertext-byte unit, optional total, completed bytes and a closed outcome.
Unknown totals stay null. Totals cannot change once known; progress cannot go
backwards or exceed known totals; terminal snapshots are immutable. Success
requires a known complete total and operation-compatible outcome. Irrecoverable
key loss is an explicit terminal failure, not automatic recovery, server
plaintext decryption or a reason to weaken integrity. It can be reported from
independently authenticated lifecycle/client evidence; this module does not
invent key-loss detection or key recovery.

Disconnect is neither cancellation nor rollback. Adapters persist jobs,
checkpoints, retained results and idempotency before acknowledging, so status
works across transport/process reconnects. The test `MemoryAuthority` demonstrates
portable resolution semantics only and **does not claim persistence or durability**.
Cancellation is an explicit request, with outcomes requested, cancelled before
commit, already committed, or cleanup required. Acknowledging a request is not
proof that all side effects stopped. Adapters reconcile actual terminal effects;
one waiter's cancellation must not erase another waiter's demand. Nothing can
recall already propagated Usenet articles or promise remote byte erasure.

## Evidence and dependency controls

Golden pairs cover every native action; invalid requests and response mutations
cover unsupported version/profile, cross-tenant scope, unknown requirements,
inline keys/payloads, limits, changed generations, metadata and invalid outcomes.
Executable reference tests cover ownership, intent/precondition replay binding,
trusted integrity receipts, reconnect, monotonic status, immutable terminal state,
range/handle/cursor binding, exact Unicode preservation and debug/error redaction.
These are protocol tests, not live-provider/client certification or crypto proof.
All full suites, native/Wasm/MSRV builds and cargo-deny run in GitHub Actions.

Serialization reuses already locked serde 1.0.229/serde_json 1.0.154 and existing
serde_derive/proc-macro dependencies; no package versions or engine revisions move.
Cargo has no stable native minimum-release-age or blanket build-script/proc-macro
refusal. These controls are unsupported, not claimed equivalent to `--locked`.
serde/serde_core build scripts and serde_derive are required existing generation
machinery; there are no new third-party lifecycle exemptions. Isolated Actions
builds and locked source/license/advisory policy remain the verification path.

REA angle: use the accepted archive representation and shared REST/MCP operation
inventory; keep existing velmora crypto/NNTP ownership rather than copying an
engine or inventing a second protocol authority.
