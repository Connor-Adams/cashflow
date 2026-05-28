const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const workflow = readFileSync('.github/workflows/promote-to-production.yml', 'utf8');

test('promotion waits for all source images before retagging and redeploying', () => {
  // Structural anchors.
  assert.match(workflow, /for attempt in \$\(seq 1 "\$IMAGE_WAIT_ATTEMPTS"\)/);
  assert.match(workflow, /IMAGE_WAIT_SECONDS:/);
  assert.match(workflow, /IMAGE_WAIT_ATTEMPTS:/);
  assert.match(
    workflow,
    /Source images are not available after \$\(\( IMAGE_WAIT_ATTEMPTS \* IMAGE_WAIT_SECONDS \)\) seconds/,
  );

  // Each service must appear in the image-wait inspect chain.
  for (const svc of ['BACKEND', 'FRONTEND', 'OTEL_COLLECTOR', 'LOKI', 'PROMETHEUS', 'GRAFANA', 'TEMPO']) {
    assert.match(
      workflow,
      new RegExp(`docker buildx imagetools inspect "\\$${svc}:sha-\\$SHA_SHORT"`),
      `image-wait must inspect ${svc}`,
    );
  }

  assert.match(
    workflow,
    /RAILWAY_PROMETHEUS_SERVICE_ID: "03a89189-868d-44af-89cf-d096a1c6e61a"/,
    'promotion must redeploy the Railway prometheus service',
  );
});
