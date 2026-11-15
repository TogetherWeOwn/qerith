import base64
import json
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
            "2026-01-01T00:00:00.000000000Z b\n2026-01-01T00:00:01.000000000Z Return\n"
        )
        (self.path / "orca.log").write_text(
            "SPEECH OUTPUT: Announce test message\n"
            "SPEECH OUTPUT: Synthetic announcement received\n"
        )
        (self.path / "speech.pcm").write_bytes(b"\xff\x7f")
        self.rows = [
            {"kind": "ready"},
            {"kind": "keydown", "key": "Enter", "target": "announce", "active": "announce",
             "documentFocused": True, "trusted": True},
            {"kind": "click", "target": "announce", "trusted": True, "detail": 0},
            {"kind": "status-mutation", "status": "Synthetic announcement received"},
        ]
        self.write_rows()

    def write_rows(self):
        lines = []
        for seq, row in enumerate(self.rows, 1):
            encoded = base64.b64encode(json.dumps(dict(row, seq=seq)).encode()).decode()
            lines.append("SR_DOM_V1=" + encoded)
        (self.path / "browser.log").write_text("\n".join(lines))

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

    def test_missing_or_untrusted_activation_is_not_evidence(self):
        for index in (1, 2):
            with self.subTest(index=index):
                self.rows[index]["trusted"] = False
                self.write_rows()
                with self.assertRaises(ValueError):
                    verify.validate(self.path)
                self.rows[index]["trusted"] = True

    def test_mutation_before_click_is_not_evidence(self):
        self.rows[2], self.rows[3] = self.rows[3], self.rows[2]
        self.write_rows()
        with self.assertRaises(ValueError):
            verify.validate(self.path)

    def test_missing_provenance_is_not_evidence(self):
        (self.path / "provenance.txt").write_text("tested_sha=unknown\n")
        with self.assertRaises(ValueError):
            verify.validate(self.path)


if __name__ == "__main__":
    unittest.main()
