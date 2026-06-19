import { Dialog, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@cashflow/ui'
import { Button } from '@cashflow/ui'
import { SanitizedHtml } from '@/components/SanitizedHtml'

type Props = {
  open: boolean
  title: string
  html: string
  onAcknowledge: () => void
  onClose: () => void
}

export function ChangelogModal({ open, title, html, onAcknowledge, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <SanitizedHtml html={html} />
      </DialogBody>
      <DialogFooter>
        <Button type="button" onClick={onAcknowledge}>Got it</Button>
      </DialogFooter>
    </Dialog>
  )
}
