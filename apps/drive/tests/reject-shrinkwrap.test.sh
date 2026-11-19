#!/usr/bin/env bash
set -eu

guard="$(dirname "$0")/../scripts/reject-shrinkwrap.sh"
dir="$(mktemp -d)"
trap 'rm -rf -- "$dir"' EXIT

bash "$guard" "$dir"
touch "$dir/npm-shrinkwrap.json"
if bash "$guard" "$dir"; then exit 1; fi
rm "$dir/npm-shrinkwrap.json"
touch "$dir/target"
ln -s target "$dir/npm-shrinkwrap.json"
if bash "$guard" "$dir"; then exit 1; fi
rm "$dir/target"
if bash "$guard" "$dir"; then exit 1; fi
printf 'Shrinkwrap guard: all four cases passed\n'
