#!/usr/bin/env bash
# Only the Actions-owned temporary venv/vendor directory is modified.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || { printf 'Actions-only setup\n' >&2; exit 1; }
root=$(cd -- "$(dirname -- "$0")" && pwd)
: "${QERITH_CLIENT_PRIVATE_DIR:?}" "${QERITH_CLIENT_EVIDENCE_DIR:?}"
mkdir -p "$QERITH_CLIENT_PRIVATE_DIR" "$QERITH_CLIENT_EVIDENCE_DIR"
private=$QERITH_CLIENT_PRIVATE_DIR
python3 -m venv "$private/venv"
python="$private/venv/bin/python"
# Bootstrap exception: the preinstalled pip lacks native age filtering. This
# exact wheel is hash-pinned, wheel-only, published 2026-04-26 (>3 days).
PIP_CONFIG_FILE=/dev/null "$python" -I -m pip --disable-pip-version-check install \
  --no-input --no-cache-dir --index-url https://pypi.org/simple \
  --only-binary=:all: --require-hashes -r "$root/pip-bootstrap.lock"
PIP_CONFIG_FILE="$root/pip.conf" "$python" -I -m pip --disable-pip-version-check install \
  --no-input --no-cache-dir --index-url https://pypi.org/simple \
  -r "$root/requirements.lock"
"$python" -I -m pip check
"$python" -I -m pip freeze --all > "$QERITH_CLIENT_EVIDENCE_DIR/python-freeze.txt"
"$python" -I -m pip config debug > "$QERITH_CLIENT_EVIDENCE_DIR/pip-config.txt"

# Each download/extraction gets its own empty directory, separate from our code.
download=$(mktemp -d "$private/vendor-download.XXXXXX")
extract=$(mktemp -d "$private/vendor-extract.XXXXXX")
url=$("$python" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["aws_cli"]["url"])' "$root/pins.json")
expected=$("$python" -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["aws_cli"]["sha256"])' "$root/pins.json")
curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time 120 --retry 2 \
  -o "$download/aws.zip" "$url"
printf '%s  %s\n' "$expected" "$download/aws.zip" | sha256sum -c -
printf '%s\n' "$expected" > "$QERITH_CLIENT_EVIDENCE_DIR/vendor-archive.sha256"
unzip -q "$download/aws.zip" -d "$extract"
# Execute the vendor installer only after validating the committed trust anchor.
bash "$extract/aws/install" --install-dir "$private/aws-cli" --bin-dir "$private/bin"
"$private/bin/aws" --version > "$QERITH_CLIENT_EVIDENCE_DIR/aws-version.txt"
"$python" -I - "$extract/aws/dist" "$QERITH_CLIENT_EVIDENCE_DIR/vendor-files.json" <<'PY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
files={}
metadata={}
for path in sorted(root.rglob('*')):
    if path.is_file():
        with path.open('rb') as stream:
            files[str(path.relative_to(root))]=hashlib.file_digest(stream,'sha256').hexdigest()
        if path.name == 'METADATA':
            metadata[str(path.relative_to(root))]=[line for line in path.read_text().splitlines()
                if line.startswith(('Name:', 'Version:', 'Requires-Dist:'))]
pathlib.Path(sys.argv[2]).write_text(json.dumps({'files':files,'dist_info':metadata},indent=2)+'\n')
PY
umask 077
openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 \
  -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$private/key.pem" -out "$private/cert.pem"
{
  printf 'QERITH_CLIENT_CERT=%s/cert.pem\n' "$private"
  printf 'QERITH_CLIENT_KEY=%s/key.pem\n' "$private"
  printf 'QERITH_AWS_CLI=%s/bin/aws\n' "$private"
} >> "$GITHUB_ENV"
printf '%s/venv/bin\n' "$private" >> "$GITHUB_PATH"
