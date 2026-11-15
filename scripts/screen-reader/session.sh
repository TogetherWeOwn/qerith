#!/usr/bin/env bash
# Runs only inside the isolated Actions desktop and network namespace.
set -euo pipefail
ulimit -f 20480
export NO_AT_BRIDGE=0 ACCESSIBILITY_ENABLED=1
mkdir -p "$HOME" "$XDG_RUNTIME_DIR" "$EVIDENCE_DIR" "$XDG_CONFIG_HOME/pulse"
chmod 700 "$XDG_RUNTIME_DIR"
# Shared-memory segments can exceed the per-file evidence limit.
printf 'enable-shm = no\n' >"$XDG_CONFIG_HOME/pulse/daemon.conf"
printf 'enable-shm = no\n' >"$XDG_CONFIG_HOME/pulse/client.conf"
export PULSE_CONFIG="$XDG_CONFIG_HOME/pulse/daemon.conf"
export PULSE_CLIENTCONFIG="$XDG_CONFIG_HOME/pulse/client.conf"
pulseaudio --dump-conf >"$EVIDENCE_DIR/pulseaudio-config.log"
grep -Eq '^enable-shm = no$' "$EVIDENCE_DIR/pulseaudio-config.log"
python3 -I -c 'import resource; assert resource.getrlimit(resource.RLIMIT_FSIZE) == (20971520, 20971520)'
cleanup() {
  if [ -n "${ORCA_PID:-}" ] && kill -0 "$ORCA_PID" 2>/dev/null; then
    kill "$ORCA_PID" 2>/dev/null || true
    if ! timeout 5s tail --pid="$ORCA_PID" -f /dev/null; then
      printf 'Orca did not exit within the teardown limit\n' >&2
      kill -KILL "$ORCA_PID" 2>/dev/null || true
    fi
    wait "$ORCA_PID" 2>/dev/null || true
  fi
  jobs -pr | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT
mkdir -p "$HOME/.local/share/orca"
install -m 600 "$(dirname "$0")/orca-diagnostic.py" "$HOME/.local/share/orca/orca-customizations.py"
openbox >"$EVIDENCE_DIR/window-manager.log" 2>&1 &
pulseaudio --daemonize=no --exit-idle-time=-1 --log-level=info --log-target=stderr >"$EVIDENCE_DIR/pulseaudio.log" 2>&1 &
PULSE_PID=$!
for _ in $(seq 1 30); do
  if pactl info >/dev/null 2>&1; then break; fi
  if ! kill -0 "$PULSE_PID" 2>/dev/null; then
    printf 'PulseAudio exited during startup; see pulseaudio.log\n' >&2
    exit 1
  fi
  sleep 0.5
done
pactl info >/dev/null
pactl load-module module-null-sink sink_name=orca_capture >/dev/null
pactl set-default-sink orca_capture
parec --device=orca_capture.monitor --format=s16le --rate=16000 --channels=1 >"$EVIDENCE_DIR/speech.pcm" 2>"$EVIDENCE_DIR/audio.log" &
orca --disable braille --debug-file="$EVIDENCE_DIR/orca.log" >"$EVIDENCE_DIR/orca-process.log" 2>&1 &
ORCA_PID=$!
google-chrome --no-first-run --disable-background-networking --disable-sync --enable-logging=stderr --log-level=0 \
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
telemetry="$(dirname "$0")/telemetry.py"
wait_ready() {
  for _ in $(seq 1 60); do
    kill -0 "$ORCA_PID"; kill -0 "$BROWSER_PID"
    if python3 -I "$telemetry" "$EVIDENCE_DIR/browser.log" "$1"; then
      if [ "$1" = document ] && ! grep -F 'WEB: Updating loading state and resetting live regions' "$EVIDENCE_DIR/orca.log" >/dev/null; then
        sleep 0.2
        continue
      fi
      if [ "$1" != button ] || grep -E 'SPEECH OUTPUT:.*Announce test message|SPEECH DISPATCHER: Speaking.*Announce test message' "$EVIDENCE_DIR/orca.log" >/dev/null; then
        return 0
      fi
    fi
    sleep 0.2
  done
  printf 'Timed out waiting for %s readiness\n' "$1" >&2
  return 1
}
send_key() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" "$1" >>"$EVIDENCE_DIR/keystrokes.log"
  xdotool key --clearmodifiers "$1"
}
wait_ready document
send_key b
wait_ready button
# The verifier also requires a focused trusted Return and a subsequent mutation.
send_key Return
sleep 3
kill -0 "$ORCA_PID"; kill -0 "$BROWSER_PID"
