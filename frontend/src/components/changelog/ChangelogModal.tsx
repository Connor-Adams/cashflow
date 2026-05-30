/**
 * ChangelogModal — shows the latest changelog entry in a dialog.
 * Dismissed by clicking "Got it", which marks the entry as seen.
 *
 * Issue #294 — in-app What's New changelog surface.
 */
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ChangelogModalProps {
  entry: { version: string; title: string; html: string; publishedAt: string }
  onDismiss: () => void
}

export function ChangelogModal({ entry, onDismiss }: ChangelogModalProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onDismiss()
      }}
      className="max-w-lg"
    >
      <DialogHeader>
        <DialogTitle>{entry.title}</DialogTitle>
        <p
          className="text-xs"
          style={{ color: 'var(--muted-foreground)' }}
          aria-label="Published date"
        >
          {entry.publishedAt}
        </p>
      </DialogHeader>
      <DialogBody className="prose prose-sm max-h-[60vh] overflow-y-auto">
        {/* html is sanitized server-side by changelogService */}
        <div
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: entry.html }}
        />
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="primary" onClick={onDismiss}>
          Got it
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
