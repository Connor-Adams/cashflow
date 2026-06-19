import { describe, it, expect } from 'vitest'

describe('package scaffold', () => {
  it('loads the barrel module without throwing', async () => {
    const mod = await import('../index')
    expect(mod).toBeTypeOf('object')
  })
})
