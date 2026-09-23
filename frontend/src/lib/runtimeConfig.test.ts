import { afterEach, describe, expect, it } from 'vitest'

import { apiBase } from './runtimeConfig'

type Configurable = { __CASHFLOW_CONFIG__?: { API_BASE?: string } }

function setInjected(value: string | undefined) {
  if (value === undefined) {
    delete (globalThis as Configurable).__CASHFLOW_CONFIG__
  } else {
    ;(globalThis as Configurable).__CASHFLOW_CONFIG__ = { API_BASE: value }
  }
}

afterEach(() => setInjected(undefined))

describe('apiBase', () => {
  it('prefers the value injected by the container at start-up', () => {
    setInjected('https://api-cashflow.example.test')
    expect(apiBase()).toBe('https://api-cashflow.example.test')
  })

  it('strips a trailing slash so appended paths do not double up', () => {
    // Without this, `${apiBase()}/api/health` yields `...test//api/health`,
    // which some proxies treat as a different route.
    setInjected('https://api-cashflow.example.test/')
    expect(apiBase()).toBe('https://api-cashflow.example.test')
  })

  it('falls back to same-origin when nothing is injected', () => {
    // No container config and no build-time value: the API is proxied under the
    // same host, which is how `yarn dev` serves it.
    setInjected(undefined)
    expect(apiBase()).toBe(import.meta.env.VITE_API_BASE ?? '')
  })

  it('ignores an injected empty string rather than treating it as configured', () => {
    // The generated runtime-config.js writes an empty value when the container
    // has no API_BASE set. That must mean "unset", not "same-origin override",
    // so the build-time fallback still applies.
    setInjected('')
    expect(apiBase()).toBe(import.meta.env.VITE_API_BASE ?? '')
  })
})
