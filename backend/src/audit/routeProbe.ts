// Probe mechanism: ephemeral session approach.
// Mints a real Session row (60-second lifetime) for the audit-token user,
// calls each manifested API via supertest, then destroys the session in a
// finally block. A crash mid-probe leaves a short-lived session row until
// expiry — acceptable for a self-issued audit on the user's own data.

import type { Express } from 'express';
import supertest from 'supertest';
import crypto from 'crypto';
import { Session } from '../models';
import { SESSION_COOKIE } from '../auth/middleware';
import { ROUTE_MANIFEST } from './routesManifest';

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function buildRouteProbe(app: Express, userId: number) {
  // Mint a short-lived session with a real token hash
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 60_000);
  const session = await Session.create({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
  });
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;

  try {
    const routes = await Promise.all(
      ROUTE_MANIFEST.map(async (spec) => {
        const apis = await Promise.all(
          spec.apis.map(async (apiPath) => {
            try {
              const res = await supertest(app).get(apiPath).set('Cookie', cookie);
              const ok = res.status >= 200 && res.status < 400;
              return {
                path: apiPath,
                status: res.status,
                ok,
                ...(ok ? {} : { errorBody: JSON.stringify(res.body).slice(0, 500) }),
              };
            } catch (e) {
              return { path: apiPath, status: 0, ok: false, errorBody: String(e).slice(0, 500) };
            }
          })
        );
        return { page: spec.page, apis, ok: apis.every(a => a.ok) };
      })
    );
    return { routes, generatedAt: new Date().toISOString() };
  } finally {
    await session.destroy().catch(() => undefined);
  }
}
