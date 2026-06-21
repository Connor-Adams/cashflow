// Probe mechanism: Option A — ephemeral session.
// Mints a real Session row for the audit-token's user (expiresAt = now + 60s),
// dispatches each manifested API call via supertest(app) with the session cookie,
// then destroys the session in a finally block. If a process crash occurs mid-probe,
// the session row expires harmlessly within 60 seconds.
import crypto from 'crypto';
import request from 'supertest';
import type { Application } from 'express';
import { Session } from '../models';
import { hashToken } from '../auth/password';
import { SESSION_COOKIE } from '../auth/middleware';
import { ROUTE_MANIFEST } from './routesManifest';

export type RouteProbeResult = {
  routes: Array<{
    page: string;
    apis: Array<{
      path: string;
      status: number;
      ok: boolean;
      errorBody?: string;
    }>;
    ok: boolean;
  }>;
  generatedAt: string;
};

/**
 * Probe every manifested API route against the live Express app.
 *
 * `app` is passed in by the caller (the audit route handler supplies `req.app`,
 * which Express sets to the running application instance) rather than imported
 * from `../app`. That import would form a cycle — app → routeRegistry →
 * routes/audit → routeProbe → app — which fallow flags. Injecting the app keeps
 * routeProbe a leaf and uses the exact same singleton, so behavior is unchanged.
 */
export async function runRouteProbe(
  userId: number,
  app: Application,
): Promise<RouteProbeResult> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 60_000);
  const session = await Session.create({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });

  const cookieHeader = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;

  try {
    const routes = await Promise.all(
      ROUTE_MANIFEST.map(async (spec) => {
        const apis = await Promise.all(
          spec.apis.map(async (apiPath) => {
            const res = await request(app)
              .get(apiPath)
              .set('Cookie', cookieHeader)
              .timeout(10_000);
            const ok = res.status >= 200 && res.status < 400;
            const entry: {
              path: string;
              status: number;
              ok: boolean;
              errorBody?: string;
            } = { path: apiPath, status: res.status, ok };
            if (!ok) {
              const body =
                typeof res.text === 'string'
                  ? res.text.slice(0, 500)
                  : JSON.stringify(res.body).slice(0, 500);
              entry.errorBody = body;
            }
            return entry;
          })
        );
        return {
          page: spec.page,
          apis,
          ok: apis.every((a) => a.ok),
        };
      })
    );

    return { routes, generatedAt: new Date().toISOString() };
  } finally {
    await session.destroy().catch(() => undefined);
  }
}
