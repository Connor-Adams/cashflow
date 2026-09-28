const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SERVICES } = require('../scripts/service-content-hash.cjs');

const workflow = readFileSync('.github/workflows/promote-to-production.yml', 'utf8');

test('promotion checks out the released commit and resolves images by content hash', () => {
  // Promotable from the release event or re-runnable by tag, so a release whose
  // promotion failed part-way can be finished without cutting a new one.
  assert.match(workflow, /ref:\s*\$\{\{\s*inputs\.tag \|\| github\.event\.release\.tag_name\s*\}\}/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /RELEASE_SHA=\$\(git rev-parse HEAD\)/);
  assert.match(workflow, /node scripts\/service-content-hash\.cjs "\$name" "\$RELEASE_SHA"/);
  assert.match(workflow, /src="\$\{image\}:tree-\$\{hash\}"/);
});

test('promotion waits for each source image before promoting', () => {
  assert.match(workflow, /for attempt in \$\(seq 1 "\$IMAGE_WAIT_ATTEMPTS"\)/);
  assert.match(workflow, /IMAGE_WAIT_SECONDS:/);
  assert.match(workflow, /IMAGE_WAIT_ATTEMPTS:/);
  assert.match(workflow, /docker buildx imagetools inspect "\$src"/);
});

test('every service gets the release version tag', () => {
  assert.match(
    workflow,
    /docker buildx imagetools create --tag "\$\{image\}:\$\{RELEASE_TAG\}" "\$src"/,
    'all services must be stamped with :<RELEASE_TAG>',
  );
});

test('only changed services re-tag production', () => {
  // Gate is digest equality against the live :production image, accounting for
  // imagetools wrapping a single manifest in an index (check children too).
  assert.match(workflow, /prod_self=\$\(digest "\$\{image\}:production"\)/);
  assert.match(workflow, /imagetools inspect --raw "\$\{image\}:production"/);
  assert.match(workflow, /\.manifests\[\]\?\.digest/);
  assert.match(workflow, /\[ "\$src_digest" = "\$prod_self" \]/);
  assert.match(workflow, /unchanged/);
  assert.match(
    workflow,
    /docker buildx imagetools create --tag "\$\{image\}:production" "\$src"/,
  );
});

test('promotion covers every service', () => {
  const block = workflow.match(/SERVICES=\(([^)]*)\)/);
  assert.ok(block, 'promote must declare a SERVICES list');
  const listed = block[1].split(/\s+/).filter(Boolean);
  for (const svc of SERVICES) {
    assert.ok(listed.includes(svc), `promote SERVICES list must include ${svc}`);
  }
});

// Railway is gone (2026-09-26); the repo deploys on Dokploy. A leftover
// `railway redeploy` is not a no-op — it exits 1 under `set -e` and aborts the
// promotion loop mid-way, which is exactly how v0.13.187 shipped a re-tagged
// backend against an untouched frontend.
// The header comment still names Railway to explain the fault isolation; what
// must not come back is anything that *runs*.
test('promotion carries no Railway remnants', () => {
  assert.doesNotMatch(workflow, /^\s*railway\s+\S/m, 'no railway CLI invocation');
  assert.doesNotMatch(workflow, /@railway\/cli/, 'no railway CLI install');
  assert.doesNotMatch(workflow, /RAILWAY_[A-Z_]+\s*:/, 'no railway env wiring');
  assert.doesNotMatch(workflow, /secrets\.RAILWAY/, 'no railway secret');
});

// One service failing must not leave the rest un-promoted. Failures are
// collected and reported after every service has had its turn.
test('a failing service does not abort the others', () => {
  assert.match(workflow, /failed=\(\)/);
  assert.match(workflow, /failed\+=\("\$name"\)/);
  assert.match(workflow, /continue/);
  assert.match(workflow, /if \[ \$\{#failed\[@\]\} -gt 0 \]/);
  assert.match(workflow, /exit 1/);
});

// The Dokploy panel is LAN-only, so CI cannot trigger the redeploy. The run has
// to say plainly which services a human must redeploy, or a green promotion
// reads as a completed deploy when nothing has actually shipped.
test('promotion reports what still needs deploying in Dokploy', () => {
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  assert.match(workflow, /Dokploy/);
  assert.match(workflow, /changed\+=\("\$name"\)/);
});
