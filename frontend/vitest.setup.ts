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

// ResizeObserver polyfill for recharts ResponsiveContainer in jsdom.
// We fire a synthetic 80×24 entry immediately on observe() so that
// ResponsiveContainer measures a non-zero size and renders the inner SVG.
class ResizeObserverMock {
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
  }
  observe(target: Element): void {
    // Immediately call back with a synthetic size so recharts renders the chart
    this.cb(
      [
        {
          target,
          contentRect: { width: 80, height: 24, top: 0, left: 0, bottom: 24, right: 80, x: 0, y: 0, toJSON: () => ({}) },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
}

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
