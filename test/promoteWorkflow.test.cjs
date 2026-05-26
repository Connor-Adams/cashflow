const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const workflow = readFileSync('.github/workflows/promote-to-production.yml', 'utf8');

test('promotion waits for both source images before retagging and redeploying', () => {
  assert.match(workflow, /for attempt in \$\(seq 1 "\$IMAGE_WAIT_ATTEMPTS"\)/);
  assert.match(workflow, /IMAGE_WAIT_SECONDS:/);
  assert.match(workflow, /IMAGE_WAIT_ATTEMPTS:/);
  assert.match(workflow, /if docker buildx imagetools inspect "\$BACKEND:sha-\$SHA_SHORT" > \/dev\/null 2>&1 && \\\n\s*docker buildx imagetools inspect "\$FRONTEND:sha-\$SHA_SHORT" > \/dev\/null 2>&1 && \\\n\s*docker buildx imagetools inspect "\$OTEL_COLLECTOR:sha-\$SHA_SHORT" > \/dev\/null 2>&1 && \\\n\s*docker buildx imagetools inspect "\$LOKI:sha-\$SHA_SHORT" > \/dev\/null 2>&1; then/);
  assert.match(workflow, /Source images are not available after \$\(\( IMAGE_WAIT_ATTEMPTS \* IMAGE_WAIT_SECONDS \)\) seconds/);
});
