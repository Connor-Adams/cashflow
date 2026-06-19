import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BentoTile } from './BentoTile'

describe('BentoTile', () => {
  it('renders no dismiss button when onDismiss is absent', () => {
    render(
      <BentoTile span={6} label="Plain tile">
        body
      </BentoTile>,
    )
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a dismiss button and calls onDismiss when clicked', async () => {
    const onDismiss = vi.fn()
    render(
      <BentoTile
        span={12}
        label="Dismissable tile"
        onDismiss={onDismiss}
        dismissLabel="Dismiss this"
      >
        body
      </BentoTile>,
    )
    const button = screen.getByRole('button', { name: 'Dismiss this' })
    await userEvent.click(button)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders the leading icon badge when an icon is supplied', () => {
    render(
      <BentoTile span={6} icon={<svg data-testid="tile-icon" />} label="Iconned">
        body
      </BentoTile>,
    )
    expect(screen.getByTestId('tile-icon')).toBeInTheDocument()
  })
})
