#!/bin/sh
# Run the backend UNIT test suite via auto-discovery.
#
# WHY A SCRIPT (and not an inline package.json glob)
# --------------------------------------------------
# The old `test` / `test:coverage` scripts hand-enumerated every test subdir
# glob in three places. A test added under a NEW subdir of backend/test/
# silently never ran (this actually happened to test/jobs/ and test/unit/).
# This script discovers ALL backend/test/**/*.test.ts EXCEPT the integration
# tree, so new subdirs are picked up automatically.
#
# WHY INTEGRATION IS EXCLUDED (do NOT fold it back in)
# ----------------------------------------------------
# Unit tests bind SQLite eagerly via test/setup.ts (per-PID DATABASE_PATH).
# Integration tests bind Postgres and must import Sequelize models only AFTER
# DATABASE_URL is set. The Sequelize models singleton binds ONE dialect per
# process, so unit + integration cannot share a run. Integration has its own
# script (`test:integration`).
#
# WHY THE EMPTY-LIST GUARD MATTERS
# --------------------------------
# `tsx --test` with NO file arguments falls back to recursive cwd discovery
# (verified: a bare `tsx --test` ran the whole tree, integration included).
# So we must NEVER invoke `tsx --test` with an empty file list. The lister
# exits nonzero and prints nothing on zero discoveries; we abort here in that
# case instead of degrading into default discovery.
#
# Runs under c8 for coverage too: c8 wraps THIS script, exports
# NODE_V8_COVERAGE, and the tsx child + its test workers inherit it, so V8
# coverage is still collected through the extra `sh` layer.
#
# `exec`s tsx so the test runner's exit status is this script's exit status
# (nonzero on any test failure -> CI gate works).
set -eu

# backend/ package root, regardless of the cwd the script is invoked from.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BACKEND_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$BACKEND_ROOT"

# Discover unit test files. If the lister exits nonzero (zero files found),
# `set -e` aborts the script here before we ever reach `tsx --test`.
FILES=$(node test/list-unit-tests.mjs)

# Belt-and-suspenders: even if the lister somehow exits 0 with empty output,
# refuse to run rather than let `tsx --test` default-discover everything.
if [ -z "$FILES" ]; then
  echo "run-unit-tests: empty unit test file list; aborting to avoid default discovery." >&2
  exit 1
fi

# Resolve tsx: prefer the one yarn put on PATH (how the old scripts ran), and
# fall back to the local bin when the script is invoked directly (e.g. in dev).
if command -v tsx >/dev/null 2>&1; then
  TSX=tsx
else
  TSX="$BACKEND_ROOT/node_modules/.bin/tsx"
fi

# Optional sharding for CI fan-out: TEST_SHARD="<index>/<total>" (1-based) makes
# node:test run only its slice of the discovered files, so a matrix of N jobs
# splits the suite N ways. Empty/unset => run everything (local + single-runner).
SHARD_FLAG=""
if [ -n "${TEST_SHARD:-}" ]; then
  SHARD_FLAG="--test-shard=$TEST_SHARD"
fi

# Word-splitting on $FILES (and $SHARD_FLAG) is intentional.
# setup.ts gives each worker a per-PID SQLite temp DB; without --import here
# parallel workers corrupt each other.
# shellcheck disable=SC2086
exec "$TSX" --import ./test/setup.ts --test $SHARD_FLAG $FILES
