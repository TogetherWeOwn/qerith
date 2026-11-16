# Historical BusyBox qualification

This is provenance evidence, not permission to install or execute the binary.
Qualification runs only on GitHub Actions. The committed lock is a candidate until
independent security and QA review, exact-head qualification, and merge complete.
The dated snapshot is historical evidence, not a statement of current suitability.

The workflow downloads Debian's published bookworm archive key into a fresh,
private temporary GnuPG home on every run. It checks that the download contains
exactly the pinned primary and signing-subkey fingerprints before importing it;
`gpgv` must report the pinned signature and no unacceptable error. The temporary
keyring is discarded after qualification; no runner or system keyring is modified.
Changes to the published key (including new subkeys) or an unavailable key make
qualification fail closed. This historical check does not establish current key
validity or revocation status. Investigate and review any needed key or pin change;
do not silently refresh or bypass these checks.

The signed snapshot selects the index digest and size, the authenticated index
selects the exact package digest and size, and only the authenticated package is
inspected. The binary is checked in memory and never executed. Qualification must
match every lock field; lock, helper, test, or workflow changes trigger the job.
The job log records the result and its Actions run binds it to the checkout SHA.
