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

# PER-TEST TIMEOUT — a hung test must fail, not burn a CI runner.
#
# `backend-test-shard (3)` once ran for FOUR HOURS on a PR before anyone killed
# it: the interest-allocation coordinator's trailing timer fired mid-test and
# took the worker's SQLite file with it. With no timeout node:test simply waits,
# and GitHub's 6h job ceiling is the only backstop. With one, the offending test
# is cancelled and NAMED in the output, which is the difference between a
# five-minute diagnosis and a four-hour one.
#
# 120s was measured, not guessed. The slowest legitimate unit test on this suite
# is `commitStatementImport.test.ts`'s "intra-file: two identical lots two days
# apart" at ~23s locally; the next two are ~13s and ~12s, and everything else is
# under 3s. 120s is ~5x the slowest, which leaves ample room for a CI runner
# being several times slower than a dev laptop while still catching a hang
# inside two minutes.
#
# Scope, honestly: --test-timeout cancels a test that is STILL RUNNING. It does
# not watchdog a worker that wedges after its last assertion — node:test has no
# flag for that — so it is a backstop for in-test hangs, not a replacement for
# fixing whatever armed the timer.
TEST_TIMEOUT_FLAG="--test-timeout=${TEST_TIMEOUT_MS:-120000}"

# Word-splitting on $FILES (and the flags) is intentional.
# setup.ts gives each worker a per-PID SQLite temp DB; without --import here
# parallel workers corrupt each other.
# shellcheck disable=SC2086
exec "$TSX" --import ./test/setup.ts --test $TEST_TIMEOUT_FLAG $SHARD_FLAG $FILES
