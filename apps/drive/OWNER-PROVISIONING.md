# Staging owner enrollment is unavailable

The [protected staging preview publisher](../../docs/drive-staging.md) does not
arm owner enrollment in either closed or activation mode, even if a prior
Worker enrollment secret is retained. A fresh staging D1 database cannot enroll
its first owner through this workflow. Live enrollment requires a separately
authorized publisher that binds an enrollment grant to the release. Never
insert or reset an owner directly in D1.

Without an active release-bound grant, an unready preview returns `503` for
`/api/deployer/owner-enrollment`. A qualified, same-origin request returns a
bodyless `404` without dispatching enrollment. Neither response means enrollment
is open.

Follow the [staging preview runbook](../../docs/drive-staging.md) for exact-SHA
qualification, activation and disablement. Never use the real owner's identity
or files in CI. Staging data is not durable or backed up.
