import { useEffect, useRef } from 'react'
import { ChatMessageItem } from './ChatMessageItem'
import { ChatProposalCard } from './ChatProposalCard'
import type { ChatMessage, ChatProposal } from '@cashflow/shared'

type Props = {
  messages: ChatMessage[]
  proposals: ChatProposal[]
  onApply: (id: number) => void | Promise<void>
  onReject: (id: number) => void | Promise<void>
  applyingId?: number | null
  proposalErrors?: Record<number, string | null>
}

/**
 * Scrolling conversation pane.
 *
 * Proposal cards are interleaved with messages by `messageId` — each
 * proposal renders directly after the assistant message that authored it.
 * Proposals without a matching message render at the bottom (defensive
 * fallback for in-flight stream events whose parent message hasn't been
 * persisted yet).
 *
 * Auto-scrolls to the bottom whenever the message or proposal list grows
 * — typical chat UX. If the user scrolls up to read earlier turns, the
 * scroll handler intentionally does NOT track them; new content jumps
 * them down. Acceptable for a v1; revisit if it gets annoying.
 */
export function ChatMessageList({
  messages,
  proposals,
  onApply,
  onReject,
  applyingId,
  proposalErrors,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length, proposals.length])

  // Group proposals by the message they were emitted from.
  const proposalsByMessage = new Map<number, ChatProposal[]>()
  const orphanProposals: ChatProposal[] = []
  for (const p of proposals) {
    if (p.messageId == null) {
      orphanProposals.push(p)
      continue
    }
    const arr = proposalsByMessage.get(p.messageId)
    if (arr) arr.push(p)
    else proposalsByMessage.set(p.messageId, [p])
  }
  // Any proposal pointing at an unknown messageId is rendered with the
  // orphans (defensive against race conditions during streaming).
  const knownIds = new Set(messages.map((m) => m.id))
  for (const [mid, arr] of proposalsByMessage) {
    if (!knownIds.has(mid)) {
      orphanProposals.push(...arr)
      proposalsByMessage.delete(mid)
    }
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-4"
      data-slot="chat-message-list"
      aria-live="polite"
      aria-busy={messages.some((m) => m.role === 'assistant' && (m.contentText ?? '') === '')}
    >
      <ol className="space-y-3">
        {messages.map((m) => {
          const ps = proposalsByMessage.get(m.id) ?? []
          return (
            <li key={`m-${m.id}`}>
              <ChatMessageItem message={m} />
              {ps.length > 0 ? (
                <div className="mt-2 space-y-2 pl-2">
                  {ps.map((p) => (
                    <ChatProposalCard
                      key={`p-${p.id}`}
                      proposal={p}
                      onApply={onApply}
                      onReject={onReject}
                      busy={applyingId === p.id}
                      error={proposalErrors?.[p.id] ?? null}
                    />
                  ))}
                </div>
              ) : null}
            </li>
          )
        })}
        {orphanProposals.length > 0 ? (
          <li>
            <div className="space-y-2">
              {orphanProposals.map((p) => (
                <ChatProposalCard
                  key={`op-${p.id}`}
                  proposal={p}
                  onApply={onApply}
                  onReject={onReject}
                  busy={applyingId === p.id}
                  error={proposalErrors?.[p.id] ?? null}
                />
              ))}
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  )
}
