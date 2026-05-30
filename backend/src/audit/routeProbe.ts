// Option A — ephemeral session approach.
// Mints a real Session row for the audit-token's user (expiresAt = now+60s),
// spins a temporary HTTP server around the Express `app` on a random OS port,
// fires each manifested API call, then tears the session and server down in a
// finally block. A process crash mid-probe leaves the 60-second session row
// until expiry — acceptable for a self-issued audit on the owner's own data.
// supertest is a devDependency; we avoid it here by using Node's native http
// module to keep this file production-safe.
import http from 'http';
import crypto from 'crypto';
import app from '../app';
import { Session } from '../models';
import { hashToken } from '../auth/password';
import { SESSION_COOKIE } from '../auth/middleware';
import { ROUTE_MANIFEST } from './routesManifest';

export interface RouteProbeResult {
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
}

async function httpGet(
  server: http.Server,
  path: string,
  cookieHeader: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number } | null;
    if (!addr) {
      reject(new Error('server not listening'));
      return;
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path,
        method: 'GET',
        headers: { Cookie: cookieHeader },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 500, body: body.slice(0, 500) }));
      }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('probe timeout'));
    });
    req.end();
  });
}

export async function routeProbe(userId: number): Promise<RouteProbeResult> {
  const plaintext = crypto.randomBytes(24).toString('base64url');
  const tokenHash = hashToken(plaintext);
  const expiresAt = new Date(Date.now() + 60_000);

  const session = await Session.create({ userId, tokenHash, expiresAt });
  const cookieHeader = `${SESSION_COOKIE}=${encodeURIComponent(plaintext)}`;

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const routes = await Promise.all(
      ROUTE_MANIFEST.map(async (spec) => {
        const apis = await Promise.all(
          spec.apis.map(async (apiPath) => {
            try {
              const { status, body } = await httpGet(server, apiPath, cookieHeader);
              const ok = status >= 200 && status < 400;
              return { path: apiPath, status, ok, ...(ok ? {} : { errorBody: body }) };
            } catch (e) {
              return { path: apiPath, status: 0, ok: false, errorBody: String(e) };
            }
          })
        );
        return { page: spec.page, apis, ok: apis.every((a) => a.ok) };
      })
    );
    return { routes, generatedAt: new Date().toISOString() };
  } finally {
    await session.destroy().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
