#!/usr/bin/env bash
# Runs only inside the isolated Actions desktop and network namespace.
set -euo pipefail
ulimit -f 20480
export NO_AT_BRIDGE=0 ACCESSIBILITY_ENABLED=1
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$EVIDENCE_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
cleanup() { jobs -pr | xargs -r kill 2>/dev/null || true; }
trap cleanup EXIT
openbox >"$EVIDENCE_DIR/window-manager.log" 2>&1 &
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=orca_capture >/dev/null
pactl set-default-sink orca_capture
parec --device=orca_capture.monitor --format=s16le --rate=16000 --channels=1 >"$EVIDENCE_DIR/speech.pcm" 2>"$EVIDENCE_DIR/audio.log" &
orca --disable braille --debug-file="$EVIDENCE_DIR/orca.log" >"$EVIDENCE_DIR/orca-process.log" 2>&1 &
ORCA_PID=$!
google-chrome --no-first-run --disable-background-networking --disable-sync \
  --force-renderer-accessibility --user-data-dir="$HOME/chrome" \
  "file://$FIXTURE" >"$EVIDENCE_DIR/browser.log" 2>&1 &
BROWSER_PID=$!
window=''
for _ in $(seq 1 60); do
  kill -0 "$ORCA_PID"; kill -0 "$BROWSER_PID"
  window=$(xdotool search --onlyvisible --name 'Screen reader harness self-test' 2>/dev/null | tr '\n' ' ' || true)
  [ -n "$window" ] && break
  sleep 0.5
done
[ -n "$window" ]
xdotool windowactivate --sync ${window%% *}
sleep 3
for key in Tab Return; do
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" "$key" >>"$EVIDENCE_DIR/keystrokes.log"
  xdotool key --clearmodifiers "$key"
  sleep 3
done
kill -0 "$ORCA_PID"; kill -0 "$BROWSER_PID"
