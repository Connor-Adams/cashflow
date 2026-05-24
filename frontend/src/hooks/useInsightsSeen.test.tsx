import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useInsightsSeen } from './useInsightsSeen'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type HookValue = ReturnType<typeof useInsightsSeen>

function Probe({
  userId,
  onMount,
}: {
  userId: string
  onMount: (v: HookValue) => void
}) {
  const v = useInsightsSeen(userId)
  useEffect(() => {
    onMount(v)
  })
  return null
}

describe('useInsightsSeen', () => {
  it('reports all insights unseen when storage is empty', () => {
    let captured: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u1" onMount={(v) => { captured = v }} />)
    })
    expect(captured!.isSeen('2026-05', 'spend', 'Dining up')).toBe(false)
  })

  it('persists seen signatures across renders and instances', () => {
    let captured: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u1" onMount={(v) => { captured = v }} />)
    })
    act(() => {
      captured!.markSeen('2026-05', 'spend', 'Dining up')
    })
    act(() => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    let captured2: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u1" onMount={(v) => { captured2 = v }} />)
    })
    expect(captured2!.isSeen('2026-05', 'spend', 'Dining up')).toBe(true)
  })

  it('isolates seen state by userId', () => {
    let first: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u1" onMount={(v) => { first = v }} />)
    })
    act(() => {
      first!.markSeen('2026-05', 'spend', 'Dining up')
    })
    act(() => root.unmount())
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    let other: HookValue | null = null
    act(() => {
      root.render(<Probe userId="u2" onMount={(v) => { other = v }} />)
    })
    expect(other!.isSeen('2026-05', 'spend', 'Dining up')).toBe(false)
  })
})
