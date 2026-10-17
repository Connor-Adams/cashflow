import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useUnmountSafeTimeout } from './useUnmountSafeTimeout'

describe('useUnmountSafeTimeout', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('runs the callback once the delay elapses', () => {
    const spy = vi.fn()
    const { result } = renderHook(() => useUnmountSafeTimeout())

    result.current(spy, 2000)
    expect(spy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not run the callback after the component unmounts', () => {
    // The whole point: a timer that outlives its component calls setState on a
    // torn-down tree, which in jsdom means React reaches for a `window` that is
    // already gone — an unhandled rejection that reds a whole vitest run.
    const spy = vi.fn()
    const { result, unmount } = renderHook(() => useUnmountSafeTimeout())

    result.current(spy, 2000)
    unmount()
    vi.advanceTimersByTime(10_000)

    expect(spy).not.toHaveBeenCalled()
  })

  it('leaves no pending timer behind on unmount', () => {
    const { result, unmount } = renderHook(() => useUnmountSafeTimeout())

    result.current(() => {}, 2000)
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('replaces a pending timer when scheduled again', () => {
    // Every caller is a "flash a flag, then put it back" handler the user can
    // re-trigger; the latest press must own the window, not the first.
    const first = vi.fn()
    const second = vi.fn()
    const { result } = renderHook(() => useUnmountSafeTimeout())

    result.current(first, 2000)
    vi.advanceTimersByTime(1000)
    result.current(second, 2000)
    vi.advanceTimersByTime(2000)

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('keeps working after a StrictMode-style effect remount', () => {
    // React StrictMode runs effect cleanup then re-runs the effect on mount.
    // If cleanup permanently latches the hook "inactive", every later schedule
    // silently no-ops and the feature dies in development.
    const spy = vi.fn()
    const { result, rerender } = renderHook(() => useUnmountSafeTimeout())

    rerender()
    result.current(spy, 2000)
    vi.advanceTimersByTime(2000)

    expect(spy).toHaveBeenCalledTimes(1)
  })
})
