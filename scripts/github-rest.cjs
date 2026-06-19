#!/usr/bin/env node
/**
 * Minimal GitHub REST helper shared by the "signal → issue" scripts
 * (scripts/audit-issues.cjs and scripts/grafana-alert-to-issue.cjs).
 *
 * Built on Node's `https` so the scripts need no node_modules at runtime — the
 * grafana-alert-to-issue workflow checks out the repo without installing deps.
 *
 * Auth: a `GITHUB_TOKEN` env var (the workflow's built-in token or a PAT with
 * `issues: write`).
 */

'use strict';

const https = require('https');

/**
 * Make an authenticated GitHub REST request.
 * Resolves to the parsed JSON body; rejects on any 4xx/5xx.
 *
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {string} urlPath  — e.g. `/repos/owner/repo/issues`
 * @param {object} [body]   — JSON body for write requests
 * @param {string} [userAgent]
 */
function githubRequest(method, urlPath, body, userAgent = 'cashflow-signal-to-issue') {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': userAgent,
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`GitHub API ${res.statusCode}: ${data}`));
          } else {
            resolve(data ? JSON.parse(data) : {});
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Create a label, treating "already exists" (422) as success. Idempotent.
 */
async function ensureLabel(request, repo, name, color, description) {
  try {
    await request('POST', `/repos/${repo}/labels`, { name, color, description });
  } catch (e) {
    if (!String(e.message).includes('422')) throw e;
  }
}

module.exports = { githubRequest, ensureLabel };
