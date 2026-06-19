import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Dialog, DialogTitle } from '../dialog'

describe('Dialog', () => {
  it('renders its title when open', () => {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogTitle>Confirm delete</DialogTitle>
      </Dialog>,
    )
    expect(screen.getByText('Confirm delete')).toBeInTheDocument()
  })
})
