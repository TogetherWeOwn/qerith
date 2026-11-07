# qerith

Rust workspace for Qerith, built on the shared
[velmora](https://github.com/TogetherWeOwn/velmora) Usenet engine.

| Crate | Library | What |
|---|---|---|
| `crates/qerith-core` | `qerith_core` | Qerith core over the pinned engine. Re-exports velmora's non-crypto surface: NNTP client and transports, yEnc, NZB parser |

No engine code lives in this repo. Protocol, codecs, parsers and transports
are velmora's; product code goes here.

## Engine pin

`qerith-core` depends on velmora by immutable git `rev`, never by branch or
tag:

```toml
velmora = { version = "0.1.0", git = "https://github.com/TogetherWeOwn/velmora", rev = "c5e79d617896490a47d577a9b062cd0010e0bc8a", default-features = false }
```

The `native-tls` (default) and `worker-transport` features of `qerith-core`
forward to the same velmora features. The dev-dependency
`velmora-test-nntp` (the synthetic NNTP server the smoke test uses) is
pinned to the same rev, and `Cargo.lock` records that exact commit for
both. `deny.toml` allows exactly this one git source.

Qerith does not build on `velmora::decrypt` (rclone-crypt). Its replacement
STREAM format lands in velmora first, and Qerith moves to that pin once it
merges.

### Bumping the pin

A bump is a reviewed PR in this repo:

1. Pick a full 40-character commit SHA that is on velmora's `main`.
2. Replace the `rev` on **both** velmora entries in
   `crates/qerith-core/Cargo.toml` (`velmora` and `velmora-test-nntp`). If
   either package's `version` changed at the new rev, update its `version`
   requirement there too, or Cargo cannot resolve the new rev.
3. Refresh the lock for those packages only:
   `cargo update -p velmora -p velmora-test-nntp`.
4. Open the PR with the old and new SHAs and a link to the velmora changes
   in between. CI (`ci-ok`) checks the bump: the smoke test in
   `crates/qerith-core/tests/pinned_engine_smoke.rs`, `cargo-deny`, and a
   check that every git source in `Cargo.lock` is velmora at a full
   40-character `rev`. `ci-ok` blocks the merge only once it is a required
   status check on `main`; until then, a reviewer must confirm it is green.

## Checks

CI (`.github/workflows/ci.yml`, aggregated as `ci-ok`) runs `cargo fmt`,
`cargo clippy --locked --workspace --all-targets -- -D warnings`, the native
test suite, the MSRV (1.89) check,
`cargo check --target wasm32-unknown-unknown` (scalar, `worker-transport`
and simd128), `cargo-deny` against `deny.toml`, and the immutable-rev pin check on
`Cargo.lock`.

## License

MIT, see [LICENSE](LICENSE).
