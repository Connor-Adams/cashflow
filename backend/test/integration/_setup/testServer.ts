/**
 * Persistent-server wrappers for supertest, shared across integration suites.
 *
 * WHY THIS EXISTS
 * ---------------
 * Passing the Express *app* to supertest (`request.agent(app)` /
 * `request(app)`) makes supertest spin up a throwaway `app.listen(0)` server
 * for EVERY request and tear it down afterwards. Under load that churn races:
 * an http keep-alive socket is occasionally reused against a server that the
 * previous request already closed, surfacing as an intermittent
 * `socket hang up` / ECONNRESET (~1 in 4 full `yarn ci` runs).
 *
 * Binding supertest to ONE long-lived listener per app removes the race (and
 * the per-request listen/close overhead). Integration files run one process
 * per file with tests sequential within the file, so a single shared server
 * per app is safe. `unref()` keeps the listener from holding the event loop
 * open, so the test process still exits cleanly without an explicit close.
 *
 * Usage: replace `request.agent(app)` with `testAgent(app)` and
 * `request(app)` with `testRequest(app)`. Everything else (cookie jar,
 * chained matchers) is unchanged — these return the same supertest objects.
 * The names are deliberately distinct from the common local `agent` variable
 * so the swap never shadows a test's own binding.
 */
import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'http';

const servers = new WeakMap<Express, Server>();

function serverFor(app: Express): Server {
  let server = servers.get(app);
  if (!server) {
    server = app.listen(0);
    server.unref();
    servers.set(app, server);
  }
  return server;
}

export function testAgent(app: Express): ReturnType<typeof request.agent> {
  return request.agent(serverFor(app));
}

export function testRequest(app: Express): ReturnType<typeof request> {
  return request(serverFor(app));
}
