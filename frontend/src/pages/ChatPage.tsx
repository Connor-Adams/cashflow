import { useCallback, useEffect, useRef, useState } from 'react'
import { getJson, postJson } from '@/lib/api'
import { useAiStatus } from '@/hooks/useAiStatus'
import { useChatStream, type ChatStreamEvent } from '@/hooks/useChatStream'
import { ChatComposer } from '@/components/chat/ChatComposer'
import { ChatEmptyState } from '@/components/chat/ChatEmptyState'
import { ChatMessageList } from '@/components/chat/ChatMessageList'
import { ChatThreadList } from '@/components/chat/ChatThreadList'
import { useToast } from '@/components/ui/toast'
import type {
  ChatMessage,
  ChatProposal,
  ChatProposalKind,
  ChatThread,
  ChatThreadDetail,
} from '@cashflow/shared'

type ApplyError =
  | { error: string; message?: string; preview_count?: number; current_count?: number }
  | { error?: undefined }

/**
 * Main `/chat` route. Two-pane layout: thread list on the left, message
 * stream + composer on the right.
 *
 * Lifecycle:
 *
 * 1. Mount → GET /api/chat/threads. Pick the first (most recent) thread
 *    if any exist; otherwise leave selection empty so the empty state
 *    renders.
 * 2. On select → GET /api/chat/threads/:id (messages + proposals).
 * 3. On send → optimistically append a user message, then open the SSE
 *    stream. Events tickle local state (assistant_token grows the
 *    streaming bubble, proposal/tool_call_result trigger a refetch).
 *    After `assistant_done` we refetch the whole thread so our local
 *    state lines up with server truth (covers tool messages that the
 *    backend persisted but didn't surface as separate stream events).
 * 4. On apply/reject → POST /api/chat/proposals/:id/(apply|reject), then
 *    refetch.
 *
 * The chat feature is gated server-side via `AiStatus.chat`; we mirror
 * that gate here so the page stays usable on disabled environments
 * (shows a disabled banner instead of an empty 404-looking page). The
 * Sidebar gates the *nav entry* on the same flag — see Sidebar.tsx.
 */
export function ChatPage() {
  const aiStatus = useAiStatus()
  const { showToast } = useToast()
  const { send, cancel, streaming } = useChatStream()

  const [threads, setThreads] = useState<ChatThread[]>([])
  const [threadsLoading, setThreadsLoading] = useState(true)
  const [selectedThreadId, setSelectedThreadId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [proposals, setProposals] = useState<ChatProposal[]>([])
  const [composerSeed, setComposerSeed] = useState<string | undefined>(undefined)

  const [applyingId, setApplyingId] = useState<number | null>(null)
  const [proposalErrors, setProposalErrors] = useState<Record<number, string | null>>({})

  // Streaming-message synthetic id (negative so it never collides with
  // persisted ids). One per in-flight assistant turn.
  const streamingMsgIdRef = useRef<number>(-1)

  // Initial thread list fetch.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await getJson<ChatThread[]>('/api/chat/threads')
        if (cancelled) return
        setThreads(list)
        if (list.length > 0 && selectedThreadId == null) {
          setSelectedThreadId(list[0].id)
        }
      } catch (e) {
        if (cancelled) return
        showToast({
          title: 'Failed to load threads',
          description: e instanceof Error ? e.message : 'Unknown error',
          variant: 'destructive',
        })
      } finally {
        if (!cancelled) setThreadsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // Intentionally empty deps — fire once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const refetchThread = useCallback(
    async (id: number) => {
      try {
        const detail = await getJson<ChatThreadDetail>(`/api/chat/threads/${id}`)
        setMessages(detail.messages)
        setProposals(detail.proposals)
      } catch (e) {
        showToast({
          title: 'Failed to load thread',
          description: e instanceof Error ? e.message : 'Unknown error',
          variant: 'destructive',
        })
      }
    },
    [showToast],
  )

  // Fetch thread details when selection changes.
  useEffect(() => {
    if (selectedThreadId == null) {
      setMessages([])
      setProposals([])
      return
    }
    void refetchThread(selectedThreadId)
  }, [selectedThreadId, refetchThread])

  const handleNewThread = useCallback(async (): Promise<ChatThread | null> => {
    try {
      const created = await postJson<ChatThread>('/api/chat/threads')
      setThreads((prev) => [created, ...prev])
      setSelectedThreadId(created.id)
      setMessages([])
      setProposals([])
      return created
    } catch (e) {
      showToast({
        title: 'Failed to create thread',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'destructive',
      })
      return null
    }
  }, [showToast])

  /**
   * Handle one chat stream event. Mutates the local message + proposal
   * buffers so the UI updates as tokens / tool results arrive.
   *
   * Note: this runs from inside `useChatStream`'s reader loop — React's
   * batched setState is sufficient; we don't wrap in flushSync.
   */
  const handleStreamEvent = useCallback((threadId: number, ev: ChatStreamEvent) => {
    switch (ev.type) {
      case 'assistant_token': {
        const sid = streamingMsgIdRef.current
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === sid)
          if (idx === -1) {
            // First token: create the synthetic streaming bubble.
            const streamingMsg: ChatMessage = {
              id: sid,
              threadId,
              role: 'assistant',
              contentText: ev.text,
              toolCalls: null,
              toolCallId: null,
              toolName: null,
              model: null,
              promptTokens: null,
              completionTokens: null,
              latencyMs: null,
              providerRequestId: null,
              createdAt: new Date().toISOString(),
            }
            return [...prev, streamingMsg]
          }
          const next = prev.slice()
          const existing = next[idx]
          next[idx] = { ...existing, contentText: (existing.contentText ?? '') + ev.text }
          return next
        })
        break
      }
      case 'tool_call_start': {
        // We don't render placeholder tool bubbles during streaming —
        // the real role=tool message is persisted server-side and shows
        // up after refetch on assistant_done. Keeping the no-op here
        // documents that we receive these events.
        break
      }
      case 'tool_call_result': {
        // Same as tool_call_start: real persisted message arrives via
        // refetch. We could render a transient toast for failures, but
        // the backend already includes the failure in the next assistant
        // turn's text.
        break
      }
      case 'proposal': {
        // Optimistically append a synthetic proposal so it surfaces
        // without waiting for the refetch. Refetch will replace it with
        // the canonical row.
        setProposals((prev) => {
          if (prev.some((p) => p.id === ev.proposalId)) return prev
          const now = new Date()
          const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000)
          const optimistic: ChatProposal = {
            id: ev.proposalId,
            threadId,
            // messageId unknown until refetch; orphan-render path picks
            // it up. Use 0 (server ids start at 1, so it can't collide).
            messageId: 0,
            kind: ev.kind as ChatProposalKind,
            payload: {},
            preview: ev.preview,
            status: 'pending',
            expiresAt: expires.toISOString(),
            appliedAt: null,
            appliedResult: null,
            createdAt: now.toISOString(),
          }
          return [...prev, optimistic]
        })
        break
      }
      case 'assistant_done': {
        // Stream completed cleanly. Drop the synthetic bubble (refetch
        // brings the real message back) and resync everything.
        const sid = streamingMsgIdRef.current
        streamingMsgIdRef.current = sid - 1
        setMessages((prev) => prev.filter((m) => m.id !== sid))
        void refetchThread(threadId)
        // Also update the thread row's lastMessageAt for re-ordering the list.
        setThreads((prev) => {
          const idx = prev.findIndex((t) => t.id === threadId)
          if (idx === -1) return prev
          const updated = { ...prev[idx], lastMessageAt: new Date().toISOString() }
          return [updated, ...prev.filter((t) => t.id !== threadId)]
        })
        break
      }
      case 'error': {
        showToast({
          title: 'Chat error',
          description: ev.message,
          variant: 'destructive',
        })
        // Clear the streaming bubble so the user can retry.
        const sid = streamingMsgIdRef.current
        streamingMsgIdRef.current = sid - 1
        setMessages((prev) => prev.filter((m) => m.id !== sid))
        void refetchThread(threadId)
        break
      }
      default: {
        // Exhaustiveness guard: TS narrows ev to `never` here.
        const _exhaustive: never = ev
        void _exhaustive
      }
    }
  }, [refetchThread, showToast])

  const handleSend = useCallback(
    async (message: string) => {
      if (selectedThreadId == null) return
      const threadId = selectedThreadId
      // Optimistically append the user message; the backend will persist
      // its own canonical copy which the post-stream refetch picks up.
      // We tag it with a negative id so the refetch's positive ids slot
      // in without duplicate keys.
      const optimisticId = -1_000_000 - messages.length
      const userMsg: ChatMessage = {
        id: optimisticId,
        threadId,
        role: 'user',
        contentText: message,
        toolCalls: null,
        toolCallId: null,
        toolName: null,
        model: null,
        promptTokens: null,
        completionTokens: null,
        latencyMs: null,
        providerRequestId: null,
        createdAt: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, userMsg])
      await send(threadId, message, (ev) => handleStreamEvent(threadId, ev))
    },
    [selectedThreadId, messages.length, send, handleStreamEvent],
  )

  const handleSeedPrompt = useCallback(
    async (prompt: string) => {
      // No thread selected → create one, then pre-fill the composer with
      // the prompt. We intentionally do NOT auto-send so the user can edit.
      let thread: ChatThread | null = null
      if (selectedThreadId == null) {
        thread = await handleNewThread()
        if (!thread) return
      }
      setComposerSeed(prompt)
      // Clear the seed on the next tick so re-clicking the same prompt
      // re-applies it (else the prop wouldn't change).
      window.requestAnimationFrame(() => setComposerSeed(undefined))
    },
    [selectedThreadId, handleNewThread],
  )

  const handleApply = useCallback(
    async (proposalId: number) => {
      if (selectedThreadId == null) return
      setApplyingId(proposalId)
      setProposalErrors((prev) => ({ ...prev, [proposalId]: null }))
      try {
        await postJson(`/api/chat/proposals/${proposalId}/apply`)
        await refetchThread(selectedThreadId)
      } catch (e) {
        const msg = applyErrorMessage(e)
        setProposalErrors((prev) => ({ ...prev, [proposalId]: msg }))
      } finally {
        setApplyingId(null)
      }
    },
    [selectedThreadId, refetchThread],
  )

  const handleReject = useCallback(
    async (proposalId: number) => {
      if (selectedThreadId == null) return
      setApplyingId(proposalId)
      setProposalErrors((prev) => ({ ...prev, [proposalId]: null }))
      try {
        await postJson(`/api/chat/proposals/${proposalId}/reject`)
        await refetchThread(selectedThreadId)
      } catch (e) {
        setProposalErrors((prev) => ({
          ...prev,
          [proposalId]: e instanceof Error ? e.message : 'Failed to reject',
        }))
      } finally {
        setApplyingId(null)
      }
    },
    [selectedThreadId, refetchThread],
  )

  // Mirror the server-side gate. While loading, render the full layout
  // so SSR / first-paint doesn't flicker.
  if (aiStatus && aiStatus.chat === false) {
    return <ChatDisabled openai={aiStatus.openai} />
  }

  return (
    <div className="flex h-[calc(100vh-4rem)]" data-slot="chat-page">
      <ChatThreadList
        threads={threads}
        selectedId={selectedThreadId}
        onSelect={setSelectedThreadId}
        onNew={() => void handleNewThread()}
        loading={threadsLoading}
      />
      <div className="flex flex-1 flex-col">
        {selectedThreadId != null ? (
          <>
            <ChatMessageList
              messages={messages}
              proposals={proposals}
              onApply={handleApply}
              onReject={handleReject}
              applyingId={applyingId}
              proposalErrors={proposalErrors}
            />
            <ChatComposer
              seed={composerSeed}
              onSend={handleSend}
              onCancel={cancel}
              streaming={streaming}
            />
          </>
        ) : (
          <ChatEmptyState onSeed={(p) => void handleSeedPrompt(p)} />
        )}
      </div>
    </div>
  )
}

function ChatDisabled({ openai }: { openai: boolean }) {
  return (
    <div
      data-slot="chat-disabled"
      className="flex h-[calc(100vh-4rem)] flex-col items-center justify-center p-8 text-center"
    >
      <h2 className="mb-2 text-lg font-semibold">Chat is disabled</h2>
      <p className="muted max-w-md text-sm">
        {openai
          ? 'Set CHAT_ENABLED=true in the backend environment to enable this feature.'
          : 'OpenAI is not configured for this account, so chat is unavailable.'}
      </p>
    </div>
  )
}

function applyErrorMessage(e: unknown): string {
  // Best-effort: surface the server `error` code verbatim (e.g.
  // "count_drifted", "expired", "not_pending"). If the api helper
  // already threw a string message, use that.
  if (e instanceof Error) {
    // Try to parse the ApiError shape (message is the server's `error`
    // field when JSON, else statusText). This is what `/lib/api.ts`
    // produces.
    return e.message || 'Failed to apply'
  }
  if (typeof e === 'string') return e
  const obj = e as ApplyError
  if (obj?.error) return obj.error
  return 'Failed to apply'
}
