import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { FeedbackPanel } from './FeedbackPanel'

/**
 * TopBar entry point for the in-app feedback surface (issue #295). A "?" icon
 * button labelled "Help and feedback" that opens the {@link FeedbackPanel}.
 * Owns the panel open state so it can live as a single self-contained widget
 * in the Layout top bar next to the notification bell.
 */
export function FeedbackButton() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Help and feedback"
        title="Help and feedback"
        className="inline-flex items-center justify-center rounded-md border border-border bg-background/60 p-1.5 text-muted-foreground hover:text-foreground"
        data-testid="top-bar-feedback-trigger"
      >
        <HelpCircle size={18} aria-hidden="true" />
      </button>
      <FeedbackPanel open={open} onOpenChange={setOpen} />
    </>
  )
}
