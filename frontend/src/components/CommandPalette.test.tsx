import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { CommandPalette, GlobalCommandPalette } from './CommandPalette'
import type { Command } from '@/lib/commands'

void React

// Tiny route mirror so tests can assert what the palette navigated to.
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="pathname">{location.pathname}</div>
}

function ControlledHarness({
  registry,
  initialOpen = true,
  initialPath = '/',
}: {
  registry?: Command[]
  initialOpen?: boolean
  initialPath?: string
}) {
  const [open, setOpen] = useState(initialOpen)
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <LocationProbe />
              <button onClick={() => setOpen(true)} data-testid="harness-open">
                Open
              </button>
              <CommandPalette
                open={open}
                onOpenChange={setOpen}
                registry={registry}
              />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  )
}

const REG: Command[] = [
  {
    id: 'nav-transactions',
    label: 'Go to Transactions',
    description: 'See every transaction',
    category: 'Navigate',
    destination: '/transactions',
    keywords: ['ledger'],
  },
  {
    id: 'create-rule',
    label: 'Create rule',
    description: 'Add a categorization rule',
    category: 'Create',
    destination: '/rules',
    keywords: ['rule', 'add'],
  },
  {
    id: 'search-merchants',
    label: 'Search merchants',
    category: 'Search',
    destination: '/transactions',
  },
  {
    id: 'ctx-rule-for-merchant',
    label: 'Create rule for this merchant',
    category: 'Context',
    destination: '/rules',
    contextMatch: (p) => p.startsWith('/merchants/'),
  },
]

beforeEach(() => {
  // Some tests render multiple times; ensure body state is clean.
  document.body.style.overflow = ''
})

describe('CommandPalette — discovery + rendering', () => {
  it('renders the palette dialog when open', () => {
    render(<ControlledHarness registry={REG} initialOpen />)
    expect(
      screen.getByRole('dialog', { name: /command palette/i }),
    ).toBeInTheDocument()
  })

  it('does not render when closed', () => {
    render(<ControlledHarness registry={REG} initialOpen={false} />)
    expect(
      screen.queryByRole('dialog', { name: /command palette/i }),
    ).not.toBeInTheDocument()
  })

  it('lists every non-contextual command on initial render', () => {
    render(<ControlledHarness registry={REG} initialOpen />)
    expect(screen.getByText('Go to Transactions')).toBeInTheDocument()
    expect(screen.getByText('Create rule')).toBeInTheDocument()
    expect(screen.getByText('Search merchants')).toBeInTheDocument()
  })

  it('hides contextual commands when pathname does not match', () => {
    render(<ControlledHarness registry={REG} initialOpen initialPath="/" />)
    expect(
      screen.queryByText('Create rule for this merchant'),
    ).not.toBeInTheDocument()
  })

  it('shows contextual commands when pathname matches', () => {
    render(
      <ControlledHarness
        registry={REG}
        initialOpen
        initialPath="/merchants/Acme"
      />,
    )
    expect(
      screen.getByText('Create rule for this merchant'),
    ).toBeInTheDocument()
  })

  it('floats Context group to the top when contextual commands are visible', () => {
    render(
      <ControlledHarness
        registry={REG}
        initialOpen
        initialPath="/merchants/Acme"
      />,
    )
    const groupHeaders = screen
      .getAllByText(/^(Context|Navigate|Create|Search|Run)$/)
      .map((el) => el.textContent)
    expect(groupHeaders[0]).toBe('Context')
  })

  it('shows an empty state when no commands match the query', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    const input = screen.getByLabelText(/search commands/i)
    await user.type(input, 'zzznope')
    expect(screen.getByTestId('command-palette-empty')).toHaveTextContent(
      /no commands match/i,
    )
  })
})

describe('CommandPalette — search filtering', () => {
  it('filters the list as the user types', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    const input = screen.getByLabelText(/search commands/i)
    await user.type(input, 'rule')
    // "Create rule" matches strongly; "Go to Transactions" does not.
    expect(screen.getByText('Create rule')).toBeInTheDocument()
    expect(screen.queryByText('Go to Transactions')).not.toBeInTheDocument()
  })

  it('matches keywords', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    const input = screen.getByLabelText(/search commands/i)
    await user.type(input, 'ledger')
    expect(screen.getByText('Go to Transactions')).toBeInTheDocument()
    expect(screen.queryByText('Create rule')).not.toBeInTheDocument()
  })
})

describe('CommandPalette — keyboard navigation', () => {
  it('first command is active by default', () => {
    render(<ControlledHarness registry={REG} initialOpen />)
    const first = screen.getByTestId('command-palette-item-nav-transactions')
    expect(first).toHaveAttribute('aria-selected', 'true')
  })

  it('ArrowDown moves selection to the next command', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    const input = screen.getByLabelText(/search commands/i)
    await user.click(input)
    await user.keyboard('{ArrowDown}')
    const second = screen.getByTestId('command-palette-item-create-rule')
    expect(second).toHaveAttribute('aria-selected', 'true')
  })

  it('ArrowUp clamps at the first command', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    const input = screen.getByLabelText(/search commands/i)
    await user.click(input)
    await user.keyboard('{ArrowUp}')
    const first = screen.getByTestId('command-palette-item-nav-transactions')
    expect(first).toHaveAttribute('aria-selected', 'true')
  })

  it('Home selects the first command, End selects the last', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    const input = screen.getByLabelText(/search commands/i)
    await user.click(input)
    await user.keyboard('{End}')
    const last = screen.getByTestId('command-palette-item-search-merchants')
    expect(last).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    const first = screen.getByTestId('command-palette-item-nav-transactions')
    expect(first).toHaveAttribute('aria-selected', 'true')
  })
})

describe('CommandPalette — command execution', () => {
  it('Enter on the active item navigates to its destination', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    const input = screen.getByLabelText(/search commands/i)
    await user.click(input)
    await user.keyboard('{ArrowDown}{Enter}')
    expect(screen.getByTestId('pathname')).toHaveTextContent('/rules')
  })

  it('Clicking an item runs it', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    await user.click(screen.getByText('Go to Transactions'))
    expect(screen.getByTestId('pathname')).toHaveTextContent('/transactions')
  })

  it('runs onRun callback when supplied', async () => {
    const onRun = vi.fn()
    function Harness() {
      const [open, setOpen] = useState(true)
      return (
        <MemoryRouter>
          <CommandPalette
            open={open}
            onOpenChange={setOpen}
            registry={REG}
            onRun={onRun}
          />
        </MemoryRouter>
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Go to Transactions'))
    expect(onRun).toHaveBeenCalledTimes(1)
    expect(onRun.mock.calls[0][0]).toMatchObject({ id: 'nav-transactions' })
  })

  it('closes after running a command', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    await user.click(screen.getByText('Go to Transactions'))
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /command palette/i }),
      ).not.toBeInTheDocument(),
    )
  })

  it('Enter is a no-op when no commands match (empty state)', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen initialPath="/" />)
    const input = screen.getByLabelText(/search commands/i)
    await user.type(input, 'zzznope{Enter}')
    expect(screen.getByTestId('pathname')).toHaveTextContent('/')
    // Palette stays open so the user can refine the search.
    expect(
      screen.getByRole('dialog', { name: /command palette/i }),
    ).toBeInTheDocument()
  })
})

describe('CommandPalette — dismissal', () => {
  it('Escape closes the palette', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    expect(
      screen.getByRole('dialog', { name: /command palette/i }),
    ).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /command palette/i }),
      ).not.toBeInTheDocument(),
    )
  })

  it('clicking the backdrop closes the palette', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    const backdrop = screen.getByTestId('command-palette-overlay')
    await user.click(backdrop)
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /command palette/i }),
      ).not.toBeInTheDocument(),
    )
  })

  it('clicking inside the dialog does not close it', async () => {
    const user = userEvent.setup()
    render(<ControlledHarness registry={REG} initialOpen />)
    const dialog = screen.getByTestId('command-palette')
    await user.click(dialog)
    expect(
      screen.getByRole('dialog', { name: /command palette/i }),
    ).toBeInTheDocument()
  })
})

describe('useCommandPalette — global shortcut', () => {
  function GlobalHarness() {
    return (
      <MemoryRouter>
        <LocationProbe />
        <GlobalCommandPalette />
      </MemoryRouter>
    )
  }

  it('Ctrl+K opens the palette from anywhere', async () => {
    const user = userEvent.setup()
    render(<GlobalHarness />)
    expect(
      screen.queryByRole('dialog', { name: /command palette/i }),
    ).not.toBeInTheDocument()
    await user.keyboard('{Control>}k{/Control}')
    expect(
      screen.getByRole('dialog', { name: /command palette/i }),
    ).toBeInTheDocument()
  })

  it('Ctrl+K toggles closed when palette is already open', async () => {
    const user = userEvent.setup()
    render(<GlobalHarness />)
    await user.keyboard('{Control>}k{/Control}')
    expect(
      screen.getByRole('dialog', { name: /command palette/i }),
    ).toBeInTheDocument()
    await user.keyboard('{Control>}k{/Control}')
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /command palette/i }),
      ).not.toBeInTheDocument(),
    )
  })

  it('Meta+K (Mac) opens the palette', async () => {
    const user = userEvent.setup()
    render(<GlobalHarness />)
    await user.keyboard('{Meta>}k{/Meta}')
    expect(
      screen.getByRole('dialog', { name: /command palette/i }),
    ).toBeInTheDocument()
  })

  it('single k key does not open the palette (typing in normal contexts)', async () => {
    const user = userEvent.setup()
    render(<GlobalHarness />)
    await user.keyboard('k')
    expect(
      screen.queryByRole('dialog', { name: /command palette/i }),
    ).not.toBeInTheDocument()
  })

  it('Ctrl+Shift+K does not open the palette', async () => {
    const user = userEvent.setup()
    render(<GlobalHarness />)
    await user.keyboard('{Control>}{Shift>}k{/Shift}{/Control}')
    expect(
      screen.queryByRole('dialog', { name: /command palette/i }),
    ).not.toBeInTheDocument()
  })
})
