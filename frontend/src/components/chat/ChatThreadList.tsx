import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ChatThread } from '@cashflow/shared'

type Props = {
  threads: ChatThread[]
  selectedId: number | null
  onSelect: (id: number) => void
  onNew: () => void
  loading?: boolean
}

/**
 * Left-rail thread list. Threads arrive already ordered by
 * `lastMessageAt DESC` from the backend; we render in iteration order.
 *
 * Width is fixed at ~280px so the conversation pane has room. On narrow
 * viewports the parent layout collapses (see ChatPage).
 */
export function ChatThreadList({ threads, selectedId, onSelect, onNew, loading }: Props) {
  return (
    <aside
      aria-label="Chat threads"
      className="flex w-72 shrink-0 flex-col border-r border-border bg-muted/10"
    >
      <div className="border-b border-border p-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="w-full justify-center"
          onClick={onNew}
        >
          <Plus size={16} aria-hidden="true" />
          <span className="ml-1">New thread</span>
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto" role="list">
        {loading ? (
          <p className="muted px-3 py-2 text-xs">Loading…</p>
        ) : threads.length === 0 ? (
          <p className="muted px-3 py-4 text-xs">No threads yet. Start a conversation.</p>
        ) : (
          threads.map((t) => (
            <ChatThreadRow
              key={t.id}
              thread={t}
              isSelected={t.id === selectedId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </aside>
  )
}

function ChatThreadRow({
  thread,
  isSelected,
  onSelect,
}: {
  thread: ChatThread
  isSelected: boolean
  onSelect: (id: number) => void
}) {
  const title = thread.title?.trim() || 'Untitled'
  const ts = thread.lastMessageAt ?? thread.createdAt
  return (
    <button
      type="button"
      role="listitem"
      onClick={() => onSelect(thread.id)}
      aria-current={isSelected ? 'true' : undefined}
      className={cn(
        'block w-full border-b border-border/40 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/30',
        isSelected && 'bg-muted/50 font-semibold',
      )}
    >
      <div className="truncate">{title}</div>
      <div className="muted truncate text-xs">{formatRelative(ts)}</div>
    </button>
  )
}

/**
 * Compact relative-time formatter ("3m", "2h", "5d"). Falls back to a date
 * string for anything older than a week.
 */
function formatRelative(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return d.toLocaleDateString()
}
