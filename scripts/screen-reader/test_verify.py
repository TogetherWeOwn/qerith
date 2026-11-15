import pathlib
import tempfile
import unittest

import verify


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = pathlib.Path(self.temp.name)
        (self.path / "provenance.txt").write_text("tested_sha=" + "a" * 40 + "\n")
        (self.path / "keystrokes.log").write_text(
            "2026-01-01T00:00:00.000000000Z Tab\n2026-01-01T00:00:01.000000000Z Return\n"
        )
        (self.path / "orca.log").write_text(
            "SPEECH OUTPUT: Announce test message\n"
            "SPEECH OUTPUT: Synthetic announcement received\n"
        )
        (self.path / "speech.pcm").write_bytes(b"\xff\x7f")

    def test_complete_evidence(self):
        verify.validate(self.path)

    def test_non_speech_log_is_not_evidence(self):
        (self.path / "orca.log").write_text("Announce test message Synthetic announcement received")
        with self.assertRaises(ValueError):
            verify.validate(self.path)

    def test_silence_is_not_evidence(self):
        (self.path / "speech.pcm").write_bytes(b"\0\0" * 20)
        with self.assertRaises(ValueError):
            verify.validate(self.path)

    def test_missing_provenance_is_not_evidence(self):
        (self.path / "provenance.txt").write_text("tested_sha=unknown\n")
        with self.assertRaises(ValueError):
            verify.validate(self.path)


if __name__ == "__main__":
    unittest.main()
