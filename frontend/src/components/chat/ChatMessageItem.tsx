import { Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@cashflow/shared'

type Props = {
  message: ChatMessage
}

/**
 * One message bubble. Visual differs by role:
 *
 * - `user`: right-aligned, primary-tinted bubble.
 * - `assistant`: left-aligned, neutral bubble. Plain text only —
 *   newlines render as `<br>` so multi-paragraph replies read cleanly.
 *   We avoid a markdown renderer to keep the bundle small.
 * - `tool`: a compact system-style row showing the tool name plus a
 *   truncated result. Tool messages are persisted by the backend for
 *   replay, but they're noise in the conversation thread — we keep them
 *   visible (audit trail) but de-emphasised.
 */
export function ChatMessageItem({ message }: Props) {
  if (message.role === 'user') return <UserMessage message={message} />
  if (message.role === 'assistant') return <AssistantMessage message={message} />
  return <ToolMessage message={message} />
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div data-role="user" className="flex justify-end">
      <div
        className="max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm"
        style={{ background: 'var(--primary)', color: 'var(--primary-foreground)' }}
      >
        {message.contentText ?? ''}
      </div>
    </div>
  )
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  // contentText may be null when the assistant produced only tool_calls
  // for this turn; suppress the empty bubble entirely in that case.
  const text = message.contentText
  if (text == null || text.trim().length === 0) return null
  return (
    <div data-role="assistant" className="flex justify-start">
      <div
        className="max-w-[80%] whitespace-pre-wrap rounded-lg border border-border bg-card px-3 py-2 text-sm"
        style={{ color: 'var(--fg)' }}
      >
        {text}
      </div>
    </div>
  )
}

function ToolMessage({ message }: { message: ChatMessage }) {
  const preview = truncate(message.contentText ?? '', 240)
  return (
    <div
      data-role="tool"
      className={cn(
        'mx-auto flex max-w-[90%] items-start gap-2 rounded-md border border-dashed border-border bg-muted/20 px-3 py-1.5 text-xs',
      )}
      style={{ color: 'var(--muted-foreground)' }}
    >
      <Wrench size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">{message.toolName ?? 'tool'}</span>
        {preview ? <span className="ml-2 break-words">{preview}</span> : null}
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n)}…`
}
