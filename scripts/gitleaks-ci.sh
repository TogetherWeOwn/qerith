#!/usr/bin/env bash
set -euo pipefail

scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/gitleaks-ci.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT

scan() {
  local repo=$1 report=${2:-"$scratch/history.json"} status=0
  # Force text patches and compare merges to their first parent without
  # restricting history traversal to the first-parent chain.
  # Also emit content when a file is renamed out of an allowed path.
  # Scanner diagnostics can echo raw policy input even with --redact.
  "${GITLEAKS_BIN:?}" git "$repo" --redact --exit-code 1 \
    --ignore-gitleaks-allow --log-opts='--text --diff-merges=first-parent --no-renames HEAD --' \
    --config "$scratch/.gitleaks.toml" --gitleaks-ignore-path "$scratch/.gitleaksignore" \
    --report-format json --report-path "$report" >/dev/null 2>&1 || status=$?
  if (( status == 0 )); then
    printf '%s\n' 'Gitleaks history scan passed; no findings reported'
  elif jq -e 'type == "array" and length > 0' "$report" >/dev/null 2>&1; then
    printf 'Gitleaks reported findings (exit %s); review privately\n' "$status" >&2
  else
    printf 'Gitleaks history scan failed (exit %s); diagnostics withheld\n' "$status" >&2
  fi
  return "$status"
}

validate_config() {
  # Only a self-contained policy can be pinned by copying one Git blob.
  python3 -I - "$1" <<'PY'
import sys
import tomllib

try:
    with open(sys.argv[1], "rb") as config:
        policy = tomllib.load(config)
except (tomllib.TOMLDecodeError, UnicodeError):
    sys.exit("Invalid gitleaks TOML policy")
# Gitleaks decodes keys case-insensitively and treats dots as separators.
for section, settings in policy.items():
    if section.lower().split(".")[0] != "extend":
        continue
    if "." in section or not isinstance(settings, dict) or any(
        key.lower().split(".")[0] == "path" for key in settings
    ):
        sys.exit("Gitleaks policy must not use extend.path; use built-in rules or inline rules")
PY
}

validate_rules() {
  local config=$1 label=$2 report="$scratch/rules.sarif"
  validate_config "$config" || return 1
  # An empty directory loads the policy without scanning repository data.
  # SARIF inventories the effective rules, including built-ins after extension.
  mkdir -p "$scratch/empty"
  if ! "${GITLEAKS_BIN:?}" dir "$scratch/empty" --config "$config" --redact \
    --report-format sarif --report-path "$report" >/dev/null 2>&1; then
    printf '%s gitleaks policy could not be loaded\n' "$label" >&2
    return 1
  fi
  if ! jq -e 'any(.runs[]; .tool.driver.rules | type == "array" and length > 0)' \
    "$report" >/dev/null 2>&1; then
    printf '%s gitleaks policy has no effective rules\n' "$label" >&2
    return 1
  fi
}

scan_history() {
  test "$(git rev-parse --verify HEAD)" = "${SCAN_HEAD:?}"
  test "$(git rev-parse --is-shallow-repository)" = false

  local policy=HEAD path changes
  if [[ "$GITHUB_EVENT_NAME" == pull_request || "$GITHUB_EVENT_NAME" == merge_group ]]; then
    # Pin both policy files to the immutable base SHA, not the candidate.
    policy=${BASE_SHA:?}
    git cat-file -e "$policy^{commit}"
    changes=$(git diff --name-only "$policy"...HEAD -- .gitleaks.toml .gitleaksignore)
    if [[ -n "$changes" ]]; then
      printf '%s\n' '::warning::Candidate policy changes are not used for the history scan.'
      if git cat-file -e HEAD:.gitleaks.toml 2>/dev/null; then
        local candidate="$scratch/candidate.toml"
        git show HEAD:.gitleaks.toml > "$candidate"
        validate_rules "$candidate" Proposed || return 1
      fi
    fi
  fi
  for path in .gitleaks.toml .gitleaksignore; do
    if git cat-file -e "$policy:$path" 2>/dev/null; then
      git show "$policy:$path" > "$scratch/$path"
    fi
  done
  validate_rules "$scratch/.gitleaks.toml" Active || return 1
  # Gitleaks also reads the source-root ignore file, even with an explicit
  # ignore path. Unlink first so a PR-controlled symlink cannot redirect writes.
  rm -f -- .gitleaksignore
  cp -- "$scratch/.gitleaksignore" .gitleaksignore
  scan . "${1:-}"
}

fake_token() {
  # Make a token-shaped value at runtime; nothing was issued by GitHub.
  printf '%s%s%s\n' 'gh' 'p_FAKE' "$(openssl rand -hex 16)"
}

assert_detected() {
  local label=$1 base=$2 commit=$3 script=$4 status=0 event=pull_request
  local report="$scratch/$label.json" log="$scratch/$label.log"
  if [[ "$label" == no-diff ]]; then event=merge_group; fi
  GITHUB_EVENT_NAME="$event" BASE_SHA="$base" SCAN_HEAD="$(git rev-parse --verify HEAD)" \
    bash "$script" scan "$report" > "$log" 2>&1 || status=$?
  if ! grep -Fq -- 'Gitleaks reported findings' "$log" ||
    grep -Fq -- 'synthetic-ignore-diagnostic-' "$log"; then
    printf 'Expected a safe finding summary in %s\n' "$label" >&2
    return 1
  fi
  if [[ "$status" != 1 ]] || ! jq -e --arg commit "$commit" \
    'any(.[]; .RuleID == "github-pat" and .File == "fixture.txt" and .Commit == $commit)' \
    "$report" >/dev/null; then
    printf 'Expected a gitleaks finding in %s (exit %s)\n' "$label" "$status" >&2
    return 1
  fi
  printf 'Detected synthetic %s finding at the expected commit\n' "$label"
}

assert_invalid_config() {
  local base=$1 script=$2 content=$3 message=$4
  shift 4
  local event
  printf '%s\n' "$content" > .gitleaks.toml
  git add .gitleaks.toml
  git commit -qm 'Change synthetic policy'
  for event in "$@"; do
    if GITHUB_EVENT_NAME="$event" BASE_SHA="$base" SCAN_HEAD="$(git rev-parse --verify HEAD)" \
      bash "$script" scan > "$scratch/policy-test.log" 2>&1; then
      printf 'Expected gitleaks policy to be rejected on %s\n' "$event" >&2
      return 1
    fi
    grep -Fx -- "$message" "$scratch/policy-test.log" || return 1
  done
}

self_test() {
  local label repo script
  script=$(realpath -- "${BASH_SOURCE[0]}")
  for label in no-diff merge-resolution rename; do
    repo="$scratch/$label"
    git init -q -b main "$repo"
    (
      cd "$repo"
      git config user.name 'Gitleaks self-test'
      git config user.email 'gitleaks-fixture@example.invalid'
      git config commit.gpgsign false
      if [[ "$label" == rename ]]; then
        printf '%s\n' '[extend]' 'useDefault = true' '[[allowlists]]' \
          "paths = ['^allowed\.txt$']" > .gitleaks.toml
        fake_token > allowed.txt
      else
        printf 'base\n' > fixture.txt
      fi
      if [[ "$label" == merge-resolution ]]; then
        # This file must not be interpreted as a git log pathspec.
        printf 'ordinary file\n' > HEAD
      elif [[ "$label" == rename ]]; then
        # Gitleaks warns with the raw entry, even with finding redaction enabled.
        printf 'synthetic-ignore-diagnostic-%s\n' "$(openssl rand -hex 8)" > .gitleaksignore
      fi
      git add --all
      git commit -qm base
      base=$(git rev-parse HEAD)
      if [[ "$label" == rename ]]; then
        git mv allowed.txt fixture.txt
        git commit -qm 'Rename synthetic fixture'
      elif [[ "$label" == no-diff ]]; then
        printf 'fixture.txt -diff\n' > .gitattributes
        fake_token > fixture.txt
        git add .gitattributes fixture.txt
        git commit -qm 'Add synthetic fixture'
      else
        git switch -qc side
        printf 'side\n' > fixture.txt
        git commit -qam side
        git switch -q main
        printf 'main\n' > fixture.txt
        git commit -qam main
        if git merge --no-edit side || [[ -z "$(git ls-files -u -- fixture.txt)" ]]; then
          printf '%s\n' 'Expected a merge conflict in fixture.txt' >&2
          exit 1
        fi
        fake_token > fixture.txt
        git add fixture.txt
        git commit -qm 'Resolve with synthetic fixture'
      fi
      leaked_at=$(git rev-parse HEAD)
      git rm -q fixture.txt
      git commit -qm 'Remove synthetic fixture'
      if [[ "$label" == no-diff ]]; then
        # A PR must not be able to suppress its own finding with either file.
        printf '%s\n' '[extend]' 'useDefault = true' '[[allowlists]]' \
          "paths = ['^fixture\.txt$']" > .gitleaks.toml
        printf '%s:fixture.txt:github-pat:1\n' "$leaked_at" > head-ignore.txt
        ln -s head-ignore.txt .gitleaksignore
        git add .gitleaks.toml .gitleaksignore head-ignore.txt
        git commit -qm 'Add untrusted scan policy'
      fi
      assert_detected "$label" "$base" "$leaked_at" "$script" || exit 1
      if [[ "$label" == no-diff ]]; then
        git diff --exit-code -- head-ignore.txt
        assert_invalid_config "$base" "$script" '[' 'Invalid gitleaks TOML policy' pull_request || exit 1
        assert_invalid_config "$base" "$script" $'[Extend]\nPath = "head-ignore.txt"' \
          'Gitleaks policy must not use extend.path; use built-in rules or inline rules' pull_request || exit 1
        assert_invalid_config "$base" "$script" '"extend.path" = "head-ignore.txt"' \
          'Gitleaks policy must not use extend.path; use built-in rules or inline rules' pull_request || exit 1
        assert_invalid_config "$base" "$script" $'[[allowlists]]\npaths = ["fixture.txt"]' \
          'Proposed gitleaks policy has no effective rules' pull_request || exit 1
        assert_invalid_config "$base" "$script" $'[[allowlists]]\npaths = ["another.txt"]' \
          'Active gitleaks policy has no effective rules' push || exit 1
      fi
    )
  done
}

printf '[extend]\nuseDefault = true\n' > "$scratch/.gitleaks.toml"
: > "$scratch/.gitleaksignore"
case "${1:-}" in
  scan) shift; scan_history "$@" ;;
  self-test) self_test ;;
  *) printf 'Usage: %s {scan|self-test}\n' "$0" >&2; exit 2 ;;
esac
