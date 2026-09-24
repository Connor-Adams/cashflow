/**
 * Unit tests for the configurable OpenAI base URL (LiteLLM proxy support).
 * No DB and no network — exercises getOpenAiConfig directly so the default,
 * the override, and the rejection rules are covered without an integration run.
 *
 * The rejection cases matter more than the happy path: the endpoint URL is
 * built from this value, so a permissive parse is a request-forgery primitive.
 * See test/integration/aiQuery.test.ts, which guards the same class of bug for
 * the hardcoded host (`https://api.openai.com.attacker.com/`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOpenAiConfig } from '../src/config/openai.js';

const ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const;

function withEnv<T>(vars: Partial<Record<(typeof ENV)[number], string>>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const k of ENV) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('defaults to the OpenAI API when OPENAI_BASE_URL is unset', () => {
  const cfg = withEnv({ OPENAI_API_KEY: 'sk-test' }, () => getOpenAiConfig());
  assert.equal(cfg?.baseUrl, 'https://api.openai.com/v1');
});

test('uses OPENAI_BASE_URL when set', () => {
  const cfg = withEnv(
    { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'http://192.168.2.3:4000/v1' },
    () => getOpenAiConfig(),
  );
  assert.equal(cfg?.baseUrl, 'http://192.168.2.3:4000/v1');
});

test('strips a trailing slash so endpoint concatenation cannot double up', () => {
  const cfg = withEnv(
    { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'http://litellm:4000/v1/' },
    () => getOpenAiConfig(),
  );
  assert.equal(cfg?.baseUrl, 'http://litellm:4000/v1');
});

test('still returns null without an API key, whatever the base URL is', () => {
  const cfg = withEnv({ OPENAI_BASE_URL: 'http://litellm:4000/v1' }, () => getOpenAiConfig());
  assert.equal(cfg, null);
});

for (const bad of [
  'not-a-url',
  'ftp://example.com/v1',
  'file:///etc/passwd',
  'javascript:alert(1)',
  '//evil.example.com/v1',
]) {
  test(`rejects a malformed or non-http base URL: ${bad}`, () => {
    assert.throws(
      () => withEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: bad }, () => getOpenAiConfig()),
      /OPENAI_BASE_URL/,
      `expected ${bad} to be rejected`,
    );
  });
}

test('an empty OPENAI_BASE_URL falls back to the default rather than throwing', () => {
  const cfg = withEnv({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: '   ' }, () =>
    getOpenAiConfig(),
  );
  assert.equal(cfg?.baseUrl, 'https://api.openai.com/v1');
});
