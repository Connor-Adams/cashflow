const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { SERVICES } = require('../scripts/service-content-hash.cjs');

const workflow = readFileSync('.github/workflows/promote-to-production.yml', 'utf8');

test('promotion checks out the released commit and resolves images by content hash', () => {
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/);
  assert.match(workflow, /RELEASE_SHA=\$\(git rev-parse HEAD\)/);
  assert.match(workflow, /node scripts\/service-content-hash\.cjs "\$name" "\$RELEASE_SHA"/);
  assert.match(workflow, /src="\$\{image\}:tree-\$\{hash\}"/);
});

test('promotion waits for each source image before promoting', () => {
  assert.match(workflow, /for attempt in \$\(seq 1 "\$IMAGE_WAIT_ATTEMPTS"\)/);
  assert.match(workflow, /IMAGE_WAIT_SECONDS:/);
  assert.match(workflow, /IMAGE_WAIT_ATTEMPTS:/);
  assert.match(
    workflow,
    /Source image not available after \$\(\( IMAGE_WAIT_ATTEMPTS \* IMAGE_WAIT_SECONDS \)\) seconds/,
  );
  assert.match(workflow, /docker buildx imagetools inspect "\$src"/);
});

test('every service gets the release version tag', () => {
  assert.match(
    workflow,
    /docker buildx imagetools create --tag "\$\{image\}:\$\{RELEASE_TAG\}" "\$src"/,
    'all services must be stamped with :<RELEASE_TAG>',
  );
});

test('only changed services re-tag production and redeploy', () => {
  // Deploy gate is digest equality against the live :production image, accounting
  // for imagetools wrapping a single manifest in an index (check children too).
  assert.match(workflow, /prod_self=\$\(digest "\$\{image\}:production"\)/);
  assert.match(workflow, /imagetools inspect --raw "\$\{image\}:production"/);
  assert.match(workflow, /\.manifests\[\]\?\.digest/);
  assert.match(workflow, /\[ "\$src_digest" = "\$prod_self" \]/);
  assert.match(workflow, /skipping redeploy/);
  assert.match(
    workflow,
    /docker buildx imagetools create --tag "\$\{image\}:production" "\$src"/,
  );
  assert.match(workflow, /railway redeploy --service "\$service_id" -y/);
});

test('promotion covers every service and its Railway target', () => {
  for (const svc of SERVICES) {
    assert.match(
      workflow,
      new RegExp(`"${svc}\\|`),
      `promote SERVICES list must include ${svc}`,
    );
  }
  assert.match(
    workflow,
    /RAILWAY_PROMETHEUS_SERVICE_ID: "03a89189-868d-44af-89cf-d096a1c6e61a"/,
    'promotion must target the Railway prometheus service',
  );
});
