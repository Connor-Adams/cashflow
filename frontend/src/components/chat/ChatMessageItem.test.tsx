import React from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ChatMessage } from '@cashflow/shared'
import { ChatMessageItem } from './ChatMessageItem'

function msg(role: ChatMessage['role'], contentText: string): ChatMessage {
  return { id: 1, role, contentText } as unknown as ChatMessage
}

describe('ChatMessageItem', () => {
  it('renders assistant markdown: bold, lists, tables', () => {
    const text = '**Total** spend\n\n- one\n- two\n\n| Cat | Amt |\n|---|---|\n| Food | 12 |'
    const { container } = render(<ChatMessageItem message={msg('assistant', text)} />)
    expect(container.querySelector('strong')?.textContent).toBe('Total')
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(container.textContent).not.toContain('**')
  })

  it('does not render raw HTML from assistant output', () => {
    const { container } = render(<ChatMessageItem message={msg('assistant', 'hi <img src=x onerror=alert(1)>')} />)
    expect(container.querySelector('img')).toBeNull()
  })

  it('keeps user messages as plain text', () => {
    const { container } = render(<ChatMessageItem message={msg('user', '**not bold**')} />)
    expect(container.querySelector('strong')).toBeNull()
    expect(container.textContent).toContain('**not bold**')
  })
})
