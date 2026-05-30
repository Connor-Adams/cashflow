/**
 * Route probe for the AI audit surface (issue #394).
 *
 * Mechanism: Option A — ephemeral session.
 * A real Session row is minted for the audit-token's user (expires in 60s).
 * Each manifested API is called via Node's built-in http module using the
 * session cookie. The session is deleted in a finally block regardless of
 * outcome. A process crash between mint and cleanup leaves a ≤60s session
 * row; acceptable risk for a self-issued audit on the user's own data.
 */
import http from 'http';
import crypto from 'crypto';
import { Session } from '../models/index';
import { hashToken } from '../auth/password';
import { ROUTE_MANIFEST } from './routesManifest';
import type { User } from '../models/User';

export type ApiProbeResult = {
  path: string;
  status: number;
  ok: boolean;
  errorBody?: string;
};

export type RouteProbeResult = {
  page: string;
  apis: ApiProbeResult[];
  ok: boolean;
};

export type RoutesProbeResponse = {
  routes: RouteProbeResult[];
  generatedAt: string;
};

function makeRequest(port: number, cookieHeader: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers: { Cookie: cookieHeader } },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => (body += chunk.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body.slice(0, 500) }));
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('probe timeout')); });
    req.end();
  });
}

export async function buildRouteProbe(user: User, localPort: number): Promise<RoutesProbeResponse> {
  const plaintext = crypto.randomBytes(24).toString('base64url');
  const tokenHash = hashToken(plaintext);
  const expiresAt = new Date(Date.now() + 60_000);

  const session = await Session.create({ userId: user.id, tokenHash, expiresAt });
  const cookieHeader = `cashflow_session=${encodeURIComponent(plaintext)}`;

  try {
    const routes: RouteProbeResult[] = await Promise.all(
      ROUTE_MANIFEST.map(async (spec) => {
        const apis: ApiProbeResult[] = await Promise.all(
          spec.apis.map(async (apiPath) => {
            try {
              const { status, body } = await makeRequest(localPort, cookieHeader, apiPath);
              const ok = status >= 200 && status < 400;
              return { path: apiPath, status, ok, ...(ok ? {} : { errorBody: body }) };
            } catch (e) {
              return { path: apiPath, status: 0, ok: false, errorBody: String(e) };
            }
          }),
        );
        return { page: spec.page, apis, ok: apis.every((a) => a.ok) };
      }),
    );
    return { routes, generatedAt: new Date().toISOString() };
  } finally {
    await session.destroy().catch(() => undefined);
  }
}
