import { Dialog } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
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
    <Dialog
      open={open}
      onClose={() => onClose()}
      title={<>{title}</>}
      footer={<Button type="button" onClick={onAcknowledge}>Got it</Button>}
    >
      <SanitizedHtml html={html} />
    </Dialog>
  )
}
