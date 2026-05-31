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

async function probeApi(
  baseUrl: string,
  apiPath: string,
  sessionCookie: string,
): Promise<{ path: string; status: number; ok: boolean; errorBody?: string }> {
  try {
    const url = `${baseUrl}${apiPath}`;
    const res = await fetch(url, {
      headers: { Cookie: sessionCookie },
      signal: AbortSignal.timeout(10_000),
    });
    const ok = res.status >= 200 && res.status < 400;
    let errorBody: string | undefined;
    if (!ok) {
      try {
        const text = await res.text();
        errorBody = text.slice(0, 500);
      } catch {
        // ignore
      }
    }
    return { path: apiPath, status: res.status, ok, errorBody };
  } catch (e) {
    return {
      path: apiPath,
      status: 0,
      ok: false,
      errorBody: String((e as Error)?.message ?? e).slice(0, 500),
    };
  }
}

export async function routeProbe(opts: {
  baseUrl: string;
  sessionCookie: string;
}): Promise<RouteProbeResult> {
  const { baseUrl, sessionCookie } = opts;
  const results = await Promise.all(
    ROUTE_MANIFEST.map(async (spec) => {
      const apis = await Promise.all(
        spec.apis.map((apiPath) => probeApi(baseUrl, apiPath, sessionCookie)),
      );
      return {
        page: spec.page,
        apis,
        ok: apis.every((a) => a.ok),
      };
    }),
  );
  return { routes: results, generatedAt: new Date().toISOString() };
}
