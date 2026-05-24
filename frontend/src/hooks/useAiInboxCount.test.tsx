import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiInboxCount } from './useAiInboxCount'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

type HookValue = ReturnType<typeof useAiInboxCount>

function Probe({ onUpdate }: { onUpdate: (v: HookValue) => void }) {
  const v = useAiInboxCount()
  useEffect(() => {
    onUpdate(v)
  })
  return null
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('useAiInboxCount', () => {
  it('updates count after fetch resolves', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ total: 4, byKind: {} }), { status: 200 }),
    )
    let captured: HookValue | null = null
    act(() => {
      root.render(<Probe onUpdate={(v) => { captured = v }} />)
    })
    await flush()
    await flush()
    expect(captured!.count).toBe(4)
    expect(captured!.loading).toBe(false)
  })

  it('returns 0 on fetch failure (silent)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'))
    let captured: HookValue | null = null
    act(() => {
      root.render(<Probe onUpdate={(v) => { captured = v }} />)
    })
    await flush()
    await flush()
    expect(captured!.count).toBe(0)
    expect(captured!.loading).toBe(false)
  })
})
