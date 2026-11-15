"""Fail closed when the synthetic desktop did not produce speech evidence."""
import array
import datetime
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import telemetry

MAX_FILE = 20 * 1024 * 1024


def bounded_read(directory, name):
    path = directory / name
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE:
        raise ValueError(f"missing, empty, or oversized evidence: {name}")
    return path.read_bytes()


def validate(directory):
    provenance = bounded_read(directory, "provenance.txt").decode("utf-8")
    if not re.search(r"(?m)^tested_sha=[0-9a-f]{40}$", provenance):
        raise ValueError("missing exact tested SHA")
    keys = bounded_read(directory, "keystrokes.log").decode("utf-8").splitlines()
    if len(keys) != 2 or not all(re.fullmatch(
        r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z (b|Return)", line
    ) for line in keys) or [line.split()[-1] for line in keys] != ["b", "Return"]:
        raise ValueError("missing timestamped self-test keys")
    timestamps = [line.split()[0] for line in keys]
    for timestamp in timestamps:
        datetime.datetime.strptime(timestamp[:19], "%Y-%m-%dT%H:%M:%S")
    if timestamps[0] > timestamps[1]:
        raise ValueError("self-test keys are out of order")
    telemetry.validate(telemetry.read_rows(directory / "browser.log"))
    log = bounded_read(directory, "orca.log").decode("utf-8", errors="replace")
    speech = [match.group(1) for line in log.splitlines()
              if (match := re.search(r"(?:SPEECH OUTPUT:|SPEECH DISPATCHER: Speaking)(.*)", line))]
    first = next((i for i, utterance in enumerate(speech)
                  if "Announce test message" in utterance), -1)
    if first < 0 or not any("Synthetic announcement received" in utterance
                            for utterance in speech[first + 1:]):
        raise ValueError("Orca did not submit the required fixture utterances in order")
    audio = bounded_read(directory, "speech.pcm")
    if len(audio) % 2:
        raise ValueError("incomplete PCM sample")
    samples = array.array("h")
    samples.frombytes(audio)
    if sys.byteorder != "little":
        samples.byteswap()
    if max(map(abs, samples), default=0) < 128:
        raise ValueError("captured audio is silent")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify.py EVIDENCE_DIR")
    validate(pathlib.Path(sys.argv[1]))
    print("Self-test speech submissions and non-silent audio captured")
