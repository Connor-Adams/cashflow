// Placeholder served during `yarn dev` and in any build that is not overwritten
// at container start-up. The deployed image replaces this file from its own
// environment via /docker-entrypoint.d/40-runtime-config.sh.
//
// An empty API_BASE means "not configured", so src/lib/runtimeConfig.ts falls
// back to the build-time value and then to same-origin.
globalThis.__CASHFLOW_CONFIG__ = { API_BASE: '' }
