#!/usr/bin/env bash
set -eu

test ! -e "$1/npm-shrinkwrap.json"
test ! -L "$1/npm-shrinkwrap.json"
