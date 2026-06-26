/**
 * Regression guard for issue #858 — unauthenticated, publicly-exposed OTLP collector.
 *
 * The otel-collector's OTLP HTTP receiver (port 4318) has NO authentication —
 * only a CORS `allowed_origins` list, which browsers enforce but curl / any OTLP
 * SDK / a compromised container ignores. So the collector MUST NOT be assigned a
 * public Railway domain: the only legitimate consumer is the backend reaching it
 * over private networking at `otel-collector.railway.internal:4318`. If browser
 * OTLP is ever needed, it must be proxied through an authenticated backend
 * endpoint, never by exposing 4318 directly.
 *
 * These tests read the infra files directly and assert:
 *  1. docs/observability.md does NOT instruct exposing 4318 publicly.
 *  2. The collector config keeps the gRPC receiver (4317) and binds the
 *     telemetry/receiver endpoints as expected for private networking.
 *
 * If the public-exposure directive drifts back into the docs, the security
 * regression fails CI here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tsx transpiles ESM specifiers to CJS at runtime, which leaves `import.meta.dirname`
// undefined in some setups. `fileURLToPath(import.meta.url)` is portable across both.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const OBSERVABILITY_DOC_PATH = path.resolve(REPO_ROOT, 'docs', 'observability.md');
const COLLECTOR_CONFIG_PATH = path.resolve(
  REPO_ROOT,
  'infra',
  'otel-collector',
  'config.yaml',
);

function loadDoc(): string {
  return fs.readFileSync(OBSERVABILITY_DOC_PATH, 'utf8');
}

function loadCollectorConfig(): string {
  return fs.readFileSync(COLLECTOR_CONFIG_PATH, 'utf8');
}

test('docs/observability.md: does NOT instruct exposing port 4318 publicly (issue #858)', () => {
  const doc = loadDoc();
  // Any line that mentions exposing 4318 AND "public(ly)" is the offending directive.
  // The collector OTLP receiver is unauthenticated; a public domain on 4318 lets any
  // non-browser client POST arbitrary telemetry (log/trace injection, alert poisoning,
  // storage DoS). CORS does not protect it.
  const offendingLines = doc
    .split('\n')
    .map((line, idx) => ({ line, lineNo: idx + 1 }))
    .filter(({ line }) => {
      const lower = line.toLowerCase();
      return (
        lower.includes('4318') &&
        /public/.test(lower) &&
        /\bexpose|expos/i.test(line)
      );
    });
  assert.equal(
    offendingLines.length,
    0,
    `docs/observability.md must NOT instruct exposing the unauthenticated OTLP ` +
      `collector port 4318 publicly. Offending line(s): ${JSON.stringify(offendingLines)}. ` +
      `The collector has no auth (CORS-only); expose 4318 over private networking ONLY ` +
      `(otel-collector.railway.internal:4318), and proxy any browser OTLP through an ` +
      `authenticated backend endpoint.`,
  );
});

test('docs/observability.md: records the private-only / authed-proxy guidance for 4318 (issue #858)', () => {
  const doc = loadDoc();
  // The fix must leave an explicit instruction that 4318 is private-only. Guard against
  // a silent deletion that drops the rationale entirely.
  assert.match(
    doc,
    /otel-collector\.railway\.internal:4318/,
    'docs/observability.md should reference the private internal endpoint otel-collector.railway.internal:4318 so onboarding wires the backend to the collector over private networking, not a public domain.',
  );
});

test('infra/otel-collector/config.yaml: keeps the gRPC (4317) receiver for internal-only use (issue #858)', () => {
  const config = loadCollectorConfig();
  assert.match(
    config,
    /endpoint:\s*0\.0\.0\.0:4317/,
    'collector config must keep the gRPC receiver on 4317 (internal-only). Binding 0.0.0.0 is correct for Railway private networking; the security requirement is no PUBLIC domain, enforced at the Railway layer + docs.',
  );
});

test('infra/otel-collector/config.yaml: carries the no-public-exposure security note for 4318 (issue #858)', () => {
  const config = loadCollectorConfig();
  // Defense-in-depth: the config a reader sees first should state, in-place, that the
  // unauthenticated receiver must not be assigned a public Railway domain. Guard against
  // a future edit silently dropping this rationale.
  // The comment wraps across lines (each prefixed with `# `), so collapse comment
  // line-breaks before matching the phrase.
  const collapsed = config.replace(/\n#\s*/g, ' ');
  assert.match(
    collapsed,
    /MUST NOT be assigned a public Railway domain/i,
    'collector config must keep the issue #858 security comment explaining the OTLP receivers are unauthenticated and must stay on private networking (no public Railway domain).',
  );
});
