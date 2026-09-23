// Where the API lives, resolved at RUNTIME rather than baked in at build time.
//
// Vite substitutes `import.meta.env.VITE_API_BASE` during the build, so the
// value becomes a string literal inside the bundle. The runtime image is nginx
// serving static files — there is no server process that could read an env var
// afterwards — which made every image environment-specific: moving the API to a
// new hostname meant rebuilding and republishing, and a tag like `:main` could
// only ever be correct for one deployment.
//
// Instead the container writes /runtime-config.js at start-up from its own
// environment, and index.html loads it before the app. One image now runs
// anywhere, and a hostname change is a redeploy.
//
// Resolution order, most specific first:
//   1. __CASHFLOW_CONFIG__.API_BASE — injected by the container at start-up
//   2. import.meta.env.VITE_API_BASE — build-time value, still used by `yarn dev`
//   3. '' — same origin, which is correct whenever the API is proxied under the
//      same host (the Vite dev server does exactly this)

type RuntimeConfig = { API_BASE?: string }

function runtimeConfig(): RuntimeConfig {
  return (globalThis as { __CASHFLOW_CONFIG__?: RuntimeConfig }).__CASHFLOW_CONFIG__ ?? {}
}

/**
 * Origin to prefix API paths with. Either an absolute origin
 * (`https://api-cashflow.rainbot.win`) or `''` meaning same-origin.
 *
 * Deliberately a function, not a constant: the injected script runs before the
 * app bundle, but reading it lazily keeps tests able to vary it and avoids
 * depending on module evaluation order.
 */
export function apiBase(): string {
  const injected = runtimeConfig().API_BASE
  if (typeof injected === 'string' && injected.length > 0) {
    // A trailing slash would produce `//api/...` once a path is appended.
    return injected.replace(/\/+$/, '')
  }
  return import.meta.env.VITE_API_BASE ?? ''
}
