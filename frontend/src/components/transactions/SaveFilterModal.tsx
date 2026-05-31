import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { postJson } from '../../lib/api'

export type SavedFilterRecord = {
  id: number
  userId: number
  name: string
  page: string
  filterJson: Record<string, unknown>
  position: number
  createdAt: string
  updatedAt: string
}

type Props = {
  open: boolean
  currentFilters: Record<string, string>
  onClose: () => void
  onSaved: (savedFilter: SavedFilterRecord) => void
}

export function SaveFilterModal({ open, currentFilters, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setName('')
      setError(null)
      setSaving(false)
    }
  }, [open])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 64) {
      setError('Name must be 1–64 characters.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await postJson<SavedFilterRecord>('/api/saved-filters', {
        name: trimmed,
        page: 'transactions',
        filterJson: currentFilters,
      })
      onSaved(saved)
      onClose()
    } catch (err: unknown) {
      const status = (err as { status?: number }).status
      if (status === 409) {
        setError('A filter with that name exists.')
      } else {
        setError('Failed to save filter. Please try again.')
      }
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose() }}>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <DialogHeader>
          <DialogTitle>Save current filter</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Label>
            Name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Last month groceries"
              maxLength={64}
              autoFocus
            />
          </Label>
          {error && (
            <p className="mt-2 text-sm" style={{ color: 'var(--destructive)' }}>
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
