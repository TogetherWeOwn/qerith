import unittest

from debian_signatures import PRIMARY, SIGNER, check_signatures


GOOD = ("[GNUPG:] PLAINTEXT 74 0\n[GNUPG:] NEWSIG\n"
        f"[GNUPG:] KEY_CONSIDERED {PRIMARY} 0\n[GNUPG:] SIG_ID x 2026-07-11 1\n"
        "[GNUPG:] GOODSIG 6ED0E7B82643E131 Debian\n"
        f"[GNUPG:] VALIDSIG {SIGNER} 2026-07-11 1 0 4 0 1 8 01 {PRIMARY}\n")
MISSING = ("[GNUPG:] NEWSIG\n[GNUPG:] ERRSIG 1234 1 8 01 1 9 FINGERPRINT\n"
           "[GNUPG:] NO_PUBKEY 1234\n")


class SignatureTests(unittest.TestCase):
    def test_pinned_signature_and_missing_other_keys(self):
        check_signatures(0, GOOD)
        check_signatures(2, GOOD + MISSING)
        check_signatures(2, MISSING + GOOD.replace("[GNUPG:] PLAINTEXT 74 0\n", ""))

    def test_rejects_bad_or_unexpected_status(self):
        cases = ((0, ""), (2, MISSING), (0, GOOD + MISSING), (2, GOOD),
                 (1, GOOD), (0, GOOD + GOOD.replace("[GNUPG:] PLAINTEXT 74 0\n", "")),
                 (0, GOOD.replace(SIGNER, "0" * 40)),
                 (0, GOOD.replace(PRIMARY, "0" * 40)),
                 (2, GOOD + MISSING.replace(" 9 FINGERPRINT", " 4 FINGERPRINT")),
                 (2, GOOD + MISSING.replace("NO_PUBKEY 1234", "NO_PUBKEY 5678")),
                 (2, GOOD + "[GNUPG:] NEWSIG\n[GNUPG:] BADSIG 1234 bad\n"),
                 (2, GOOD + MISSING + "[GNUPG:] FAILURE verify 1\n"),
                 (0, GOOD + "[GNUPG:] \n"), (0, "unexpected\n" + GOOD),
                 (0, GOOD.replace("[GNUPG:] NEWSIG", "[GNUPG:] NEWSIG extra")),
                 (0, GOOD.replace("[GNUPG:] GOODSIG", "[GNUPG:] EXPSIG")))
        for code, status in cases:
            with self.subTest(code=code, status=status), self.assertRaises(ValueError):
                check_signatures(code, status)


if __name__ == "__main__":
    unittest.main()
