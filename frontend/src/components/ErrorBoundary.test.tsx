import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ErrorBoundary } from './ErrorBoundary'

void React

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message)
}

function renderBoundary(child: React.ReactNode): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <ErrorBoundary>{child}</ErrorBoundary>
    </MemoryRouter>,
  )
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // React logs caught render errors to console.error; silence it for cleaner test output.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
    logSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('renders children unchanged when no error', () => {
    renderBoundary(<p>hello world</p>)
    expect(screen.getByText('hello world')).toBeInTheDocument()
  })

  it('renders the new fallback heading on render error', () => {
    renderBoundary(<Boom message="boom: kaput" />)
    expect(screen.getByRole('heading', { name: /something broke/i })).toBeInTheDocument()
  })

  it('shows the error message body', () => {
    renderBoundary(<Boom message="boom: detail visible" />)
    expect(screen.getByText(/boom: detail visible/i)).toBeInTheDocument()
  })

  it('truncates long error messages to 100 chars', () => {
    const long = 'x'.repeat(250)
    renderBoundary(<Boom message={long} />)
    const body = screen.getByTestId('error-boundary-message')
    // 100 chars + ellipsis
    expect(body.textContent ?? '').toMatch(/x{100}…?/)
    expect((body.textContent ?? '').length).toBeLessThanOrEqual(101)
  })

  it('renders Reload page button that calls window.location.reload', async () => {
    const reload = vi.fn()
    const origLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...origLocation, reload, href: 'http://localhost/', assign: vi.fn(), replace: vi.fn() } as unknown as Location,
    })
    try {
      renderBoundary(<Boom message="x" />)
      await userEvent.click(screen.getByRole('button', { name: /reload page/i }))
      expect(reload).toHaveBeenCalled()
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        writable: true,
        value: origLocation,
      })
    }
  })

  it('renders Go to Dashboard button that navigates to /', () => {
    renderBoundary(<Boom message="x" />)
    const link = screen.getByRole('link', { name: /go to dashboard/i })
    expect(link).toHaveAttribute('href', '/')
  })

  it('Copy error details copies full error message + stack to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderBoundary(<Boom message="failure-marker" />)
    await userEvent.click(screen.getByRole('button', { name: /copy error details/i }))
    expect(writeText).toHaveBeenCalled()
    const arg = writeText.mock.calls[0][0] as string
    expect(arg).toContain('failure-marker')
  })

  it('shows Couldn\'t copy indicator when clipboard rejects', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderBoundary(<Boom message="failure-marker" />)
    await userEvent.click(screen.getByRole('button', { name: /copy error details/i }))
    await waitFor(() => expect(screen.getByText(/couldn't copy/i)).toBeInTheDocument())
  })
})
