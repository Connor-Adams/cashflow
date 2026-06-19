import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogBody, DialogFooter, Button } from '@cashflow/ui'

const noop = () => {}

export function ConfirmDelete() {
  return (
    <Dialog open onOpenChange={noop}>
      <DialogHeader>
        <DialogTitle>Delete RBC Visa?</DialogTitle>
        <DialogDescription>This removes the account and its 1,284 imported transactions.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        Splits and receipts attached to these transactions will also be deleted. This can't be undone.
      </DialogBody>
      <DialogFooter>
        <Button variant="secondary" onClick={noop}>Cancel</Button>
        <Button variant="destructive" onClick={noop}>Delete account</Button>
      </DialogFooter>
    </Dialog>
  )
}
