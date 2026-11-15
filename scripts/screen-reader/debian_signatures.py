"""Validate gpgv status for the pinned Debian archive signing key.

This only interprets status output; callers must run gpgv against the intended
input and trusted keyring and must not use its plaintext before validation.
"""

PRIMARY = "B8B80B5B623EAB6AD8775C45B7C5D7D6350947F8"
SIGNER = "4CB50190207B4758A3F73A796ED0E7B82643E131"


def check_signatures(returncode, status):
    """Accept exactly one pinned signature and only missing-key companions."""
    groups = []
    for line in status.splitlines():
        if not line.startswith("[GNUPG:] "):
            raise ValueError("unexpected gpgv status output")
        fields = line.split()[1:]
        if not fields:
            raise ValueError("empty gpgv status")
        if fields[0] == "NEWSIG":
            if len(fields) != 1:
                raise ValueError("unexpected NEWSIG fields")
            groups.append([])
        elif fields[0] == "PLAINTEXT" and not groups:
            continue
        elif not groups:
            raise ValueError("status outside signature")
        else:
            groups[-1].append(fields)
    trusted = 0
    missing = 0
    for group in groups:
        kinds = [fields[0] for fields in group]
        if kinds == ["KEY_CONSIDERED", "SIG_ID", "GOODSIG", "VALIDSIG"]:
            valid = group[-1]
            if len(valid) != 11 or valid[1] != SIGNER or valid[-1] != PRIMARY:
                raise ValueError("unexpected release signer")
            trusted += 1
        elif kinds == ["ERRSIG", "NO_PUBKEY"]:
            error, no_key = group
            if len(error) != 8 or error[6] != "9" or len(no_key) != 2 or error[1] != no_key[1]:
                raise ValueError("unexpected signature error")
            missing += 1
        else:
            raise ValueError("gpgv rejected signature")
    if trusted != 1 or returncode != (2 if missing else 0):
        raise ValueError("gpgv did not verify the pinned signer")
