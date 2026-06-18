import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Tree, TreeGroup, TreeRow } from './tree'

describe('Tree primitives', () => {
  it('renders a row with label, icon, actions and trailing slots', () => {
    render(
      <Tree>
        <li>
          <TreeRow
            icon={<span data-testid="icon" />}
            actions={<button type="button">act</button>}
            trailing={<span>$80</span>}
          >
            Work
          </TreeRow>
        </li>
      </Tree>,
    )
    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.getByTestId('icon')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'act' })).toBeInTheDocument()
    expect(screen.getByText('$80')).toBeInTheDocument()
  })

  it('expandable row exposes a labelled toggle that fires onToggle', async () => {
    const onToggle = vi.fn()
    render(
      <Tree>
        <li>
          <TreeRow expandable expanded={false} toggleLabel="Work" onToggle={onToggle}>
            Work
          </TreeRow>
        </li>
      </Tree>,
    )
    const btn = screen.getByRole('button', { name: 'Expand Work' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(btn)
    expect(onToggle).toHaveBeenCalledOnce()
  })

  it('non-expandable row exposes no toggle control', () => {
    render(
      <Tree>
        <li>
          <TreeRow toggleLabel="Leaf">Leaf</TreeRow>
        </li>
      </Tree>,
    )
    expect(screen.queryByRole('button', { name: /expand|collapse/i })).not.toBeInTheDocument()
  })

  it('highlighted row applies the brand-tinted treatment, not the hover tint', () => {
    const { rerender } = render(
      <Tree>
        <li><TreeRow>Row</TreeRow></li>
      </Tree>,
    )
    const row = screen.getByText('Row').closest('div.group')!
    expect(row.className).toContain('hover:bg-muted/50')
    expect(row.className).not.toContain('var(--primary)')

    rerender(
      <Tree>
        <li><TreeRow highlighted>Row</TreeRow></li>
      </Tree>,
    )
    const hi = screen.getByText('Row').closest('div.group')!
    expect(hi.className).toContain('var(--primary)')
    expect(hi.className).not.toContain('hover:bg-muted/50')
  })

  it('forwards drag props onto the row element', () => {
    render(
      <Tree>
        <li><TreeRow draggable>Drag me</TreeRow></li>
      </Tree>,
    )
    expect(screen.getByText('Drag me').closest('[draggable="true"]')).not.toBeNull()
  })

  it('TreeGroup renders a nested list for children', () => {
    render(
      <Tree>
        <li>
          <TreeRow expandable expanded toggleLabel="Parent">Parent</TreeRow>
          <TreeGroup>
            <li><TreeRow>Child</TreeRow></li>
          </TreeGroup>
        </li>
      </Tree>,
    )
    expect(screen.getAllByRole('list')).toHaveLength(2)
    expect(screen.getByText('Child')).toBeInTheDocument()
  })
})
