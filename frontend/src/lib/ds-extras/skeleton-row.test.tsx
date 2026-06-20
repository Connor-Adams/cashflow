import React from 'react'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { SkeletonRow } from './skeleton-row'

describe('SkeletonRow', () => {
  it('renders `cols` cells', () => {
    const { container } = render(
      <table>
        <tbody>
          <SkeletonRow cols={4} />
        </tbody>
      </table>,
    )
    expect(container.querySelectorAll('td')).toHaveLength(4)
  })

  it('defaults to one cell', () => {
    const { container } = render(
      <table>
        <tbody>
          <SkeletonRow />
        </tbody>
      </table>,
    )
    expect(container.querySelectorAll('td')).toHaveLength(1)
  })
})
