/**
 * Vitest global setup file.
 *
 * Problem:
 * vitest's populateGlobal only copies keys listed in its KEYS array or found in
 * Object.getOwnPropertyNames(dom.window). localStorage and sessionStorage live on
 * Window.prototype as getters (not own properties), so they are NOT automatically
 * forwarded to the test global scope.
 *
 * Additionally, Node 26 declares a global `localStorage` that evaluates to
 * undefined (the experimental --localstorage-file feature), which can shadow
 * the jsdom getter.
 *
 * In the jsdom vitest environment, `window.jsdom` is the JSDOM instance, and
 * `window.jsdom.window` is the actual jsdom Window which has working localStorage.
 *
 * Fix: read localStorage/sessionStorage from the jsdom window and re-bind them
 * to globalThis so they are available in all tests without per-file workarounds.
 */

if (typeof window !== 'undefined') {
  const jsdomInstance = (window as unknown as { jsdom?: { window: Window } }).jsdom
  if (jsdomInstance?.window?.localStorage != null) {
    Object.defineProperty(globalThis, 'localStorage', {
      get: () => jsdomInstance.window.localStorage,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'sessionStorage', {
      get: () => jsdomInstance.window.sessionStorage,
      configurable: true,
    })
    // Also patch window so window.localStorage works in tests
    Object.defineProperty(window, 'localStorage', {
      get: () => jsdomInstance.window.localStorage,
      configurable: true,
    })
    Object.defineProperty(window, 'sessionStorage', {
      get: () => jsdomInstance.window.sessionStorage,
      configurable: true,
    })
  }
}
