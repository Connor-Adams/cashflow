import { Sparkles } from 'lucide-react'
import { Button } from '@cashflow/ui'

const SEEDED_PROMPTS = [
  "Show me last month's grocery spend",
  'Split groceries 50/50 starting December 2026',
  "What's outstanding with my partner?",
] as const

type Props = {
  /** Called with the seeded prompt text; the page creates a new thread + sends. */
  onSeed: (prompt: string) => void
}

/**
 * Shown in the right pane when no thread is selected. Three seeded
 * prompts kickstart a conversation — clicking one creates a new thread
 * and sends the prompt as the first message (see ChatPage.handleSeedPrompt).
 */
export function ChatEmptyState({ onSeed }: Props) {
  return (
    <div
      data-slot="chat-empty-state"
      className="flex flex-1 flex-col items-center justify-center p-8 text-center"
    >
      <Sparkles size={32} aria-hidden="true" className="mb-3 opacity-60" />
      <h2 className="mb-2 text-lg font-semibold">Ask anything about your transactions</h2>
      <p className="muted mb-6 max-w-md text-sm">
        Read your data, draft mutations, or change rules across many transactions.
        Every change is staged as a proposal — you confirm before anything is written.
      </p>
      <div className="flex flex-col gap-2">
        {SEEDED_PROMPTS.map((p) => (
          <Button
            key={p}
            type="button"
            variant="secondary"
            size="sm"
            className="justify-start"
            onClick={() => onSeed(p)}
          >
            {p}
          </Button>
        ))}
      </div>
    </div>
  )
}
