import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Help and feedback"
        title="Help and feedback"
        data-testid="top-bar-feedback-trigger"
      >
        <HelpCircle size={18} aria-hidden="true" />
      </Button>
      <FeedbackPanel open={open} onOpenChange={setOpen} />
    </>
  )
}
