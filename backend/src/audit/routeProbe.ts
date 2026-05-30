// Option A: ephemeral session approach.
// We mint a real Session row (expiresAt = now + 60s) for the audit user, call
// each manifested API via supertest, then clean up in a finally block.
// Trade-off: a process crash mid-probe leaves a short-lived session row until
// expiry — acceptable risk for a self-issued read-only probe on the user's own data.

import supertest from 'supertest';
import type { Application } from 'express';
import { Session } from '../models';
import { randomToken, hashToken } from '../auth/password';
import { SESSION_COOKIE } from '../auth/middleware';
import type { AuditAuthContext } from '../auth/auditAuth';
import { ROUTE_MANIFEST } from './routesManifest';

export interface ApiProbeResult {
  path: string;
  status: number;
  ok: boolean;
  errorBody?: string;
}

export interface RouteProbeEntry {
  page: string;
  apis: ApiProbeResult[];
  ok: boolean;
}

export interface RouteProbeResult {
  routes: RouteProbeEntry[];
  generatedAt: string;
}

export async function runRouteProbe(
  app: Application,
  auditCtx: AuditAuthContext,
): Promise<RouteProbeResult> {
  const token = randomToken(32);
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 60_000);
  let sessionId: number | undefined;

  try {
    const session = await Session.create({
      userId: auditCtx.user.id,
      tokenHash,
      expiresAt,
    });
    sessionId = session.id;

    const agent = supertest(app);
    const cookieHeader = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
    const routes: RouteProbeEntry[] = [];

    for (const spec of ROUTE_MANIFEST) {
      const apis: ApiProbeResult[] = [];
      for (const apiPath of spec.apis) {
        let status = 0;
        let body: string | undefined;
        try {
          const res = await agent.get(apiPath).set('Cookie', cookieHeader);
          status = res.status;
          if (status >= 400) {
            body =
              typeof res.body === 'object'
                ? JSON.stringify(res.body).slice(0, 500)
                : String(res.text ?? '').slice(0, 500);
          }
        } catch (e) {
          status = 0;
          body = String((e as Error)?.message ?? 'connection error').slice(0, 500);
        }
        const isOk = status >= 200 && status < 400;
        const entry: ApiProbeResult = { path: apiPath, status, ok: isOk };
        if (!isOk) entry.errorBody = body;
        apis.push(entry);
      }
      routes.push({ page: spec.page, apis, ok: apis.every((a) => a.ok) });
    }

    return { routes, generatedAt: new Date().toISOString() };
  } finally {
    if (sessionId != null) {
      void Session.destroy({ where: { id: sessionId } }).catch(() => undefined);
    }
  }
}
