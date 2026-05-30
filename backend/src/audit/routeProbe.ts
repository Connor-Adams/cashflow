// Uses an ephemeral session (60s TTL, deleted in finally) to call each
// manifested API path as the audit-token's user. The session is created and
// destroyed within this call; a crash mid-probe leaves a harmless row that
// expires naturally.
import type { Express } from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import { Session } from '../models';
import { hashToken } from '../auth/password';
import { ROUTE_MANIFEST } from './routesManifest';
import type { AuditAuthContext } from '../auth/auditAuth';

export interface RouteProbeApiResult {
  path: string;
  status: number;
  ok: boolean;
  errorBody?: string;
}

export interface RouteProbeResult {
  page: string;
  apis: RouteProbeApiResult[];
  ok: boolean;
}

export interface RouteProbeReport {
  routes: RouteProbeResult[];
  generatedAt: string;
}

async function withEphemeralSession<T>(
  userId: number,
  fn: (sessionToken: string) => Promise<T>,
): Promise<T> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  await Session.create({
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + 60_000),
  });
  try {
    return await fn(token);
  } finally {
    await Session.destroy({ where: { tokenHash } });
  }
}

export async function routeProbe(
  app: Express,
  audit: AuditAuthContext,
): Promise<RouteProbeReport> {
  return withEphemeralSession(audit.user.id, async (sessionToken) => {
    const results: RouteProbeResult[] = [];
    for (const spec of ROUTE_MANIFEST) {
      const apis = await Promise.all(
        spec.apis.map(async (apiPath): Promise<RouteProbeApiResult> => {
          const res = await request(app)
            .get(apiPath)
            .set('Cookie', `cashflow_session=${sessionToken}`);
          return {
            path: apiPath,
            status: res.status,
            ok: res.status >= 200 && res.status < 400,
            ...(res.status >= 400
              ? { errorBody: String(res.text ?? '').slice(0, 500) }
              : {}),
          };
        }),
      );
      results.push({ page: spec.page, apis, ok: apis.every((a) => a.ok) });
    }
    return { routes: results, generatedAt: new Date().toISOString() };
  });
}
