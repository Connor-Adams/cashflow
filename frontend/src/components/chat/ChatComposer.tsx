import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Send, X } from 'lucide-react'
import { Button } from '@cashflow/ui'
import { Textarea } from '@cashflow/ui'

type Props = {
  /** Pre-fill the textarea — used by seeded empty-state prompts. */
  seed?: string
  onSend: (message: string) => void | Promise<void>
  onCancel: () => void
  streaming: boolean
  /** Disable the whole composer (e.g. when AI status is loading). */
  disabled?: boolean
  placeholder?: string
}

/**
 * Message input. Cmd/Ctrl+Enter submits; plain Enter inserts a newline.
 * Send button is disabled when the textarea is empty or streaming is
 * active. While streaming, a Cancel button replaces Send.
 *
 * The textarea auto-clears on a successful send. We don't auto-grow it
 * via JS — Tailwind's `min-h-16` + the user's native browser resize is
 * good enough for v1.
 */
export function ChatComposer({
  seed,
  onSend,
  onCancel,
  streaming,
  disabled,
  placeholder,
}: Props) {
  const [value, setValue] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Apply seed prompts whenever the parent passes a new one.
  useEffect(() => {
    if (seed != null) {
      setValue(seed)
      // Defer to next frame so focus lands after React paints.
      const handle = window.requestAnimationFrame(() => {
        taRef.current?.focus()
      })
      return () => window.cancelAnimationFrame(handle)
    }
    return undefined
  }, [seed])

  const trimmed = value.trim()
  const canSend = !streaming && !disabled && trimmed.length > 0

  function handleSubmit() {
    if (!canSend) return
    void onSend(trimmed)
    setValue('')
  }

  function handleKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <form
      data-slot="chat-composer"
      className="border-t border-border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        handleSubmit()
      }}
    >
      <div className="flex items-end gap-2">
        <Textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKey}
          placeholder={placeholder ?? 'Ask anything about your transactions… (⌘+Enter to send)'}
          disabled={disabled}
          rows={3}
          className="flex-1 resize-y"
          aria-label="Chat message"
        />
        <div className="flex shrink-0 flex-col gap-2">
          {streaming ? (
            <Button
              type="button"
              variant="secondary"
              onClick={onCancel}
              aria-label="Cancel"
            >
              <X size={16} aria-hidden="true" />
              <span className="ml-1">Cancel</span>
            </Button>
          ) : (
            <Button type="submit" disabled={!canSend} aria-label="Send">
              <Send size={16} aria-hidden="true" />
              <span className="ml-1">Send</span>
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}
