import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { MemoryRouter } from 'react-router-dom'
import { ToastProvider } from '@/components/ui/toast'
import { FeedbackButton } from './FeedbackButton'

function renderButton() {
  render(
    <MemoryRouter>
      <ToastProvider>
        <FeedbackButton />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('FeedbackButton', () => {
  it('renders a "Help and feedback" button (AC#9)', () => {
    renderButton()
    expect(
      screen.getByRole('button', { name: /help and feedback/i }),
    ).toBeInTheDocument()
  })

  it('opens the feedback panel when clicked (AC#9)', async () => {
    renderButton()
    // Panel is closed initially.
    expect(screen.queryByRole('heading', { name: /send us feedback/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /help and feedback/i }))
    expect(
      await screen.findByRole('heading', { name: /send us feedback/i }),
    ).toBeInTheDocument()
  })
})
