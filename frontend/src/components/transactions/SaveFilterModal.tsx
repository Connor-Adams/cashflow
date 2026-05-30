import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label as FieldLabel } from '@/components/ui/label'
import { postJson } from '../../lib/api'

export interface SavedFilter {
  id: number
  userId: number
  name: string
  page: string
  filterJson: Record<string, unknown>
  position: number
  createdAt: string
  updatedAt: string
}

interface Props {
  page: string
  filterJson: Record<string, unknown>
  onSaved: (filter: SavedFilter) => void
  onClose: () => void
}

/**
 * Modal for saving the current filter set as a named preset (issue #272).
 * Handles DUPLICATE_NAME and INVALID_NAME errors inline.
 */
export function SaveFilterModal({ page, filterJson, onSaved, onClose }: Props) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    setErr(null)
    try {
      const filter = await postJson<SavedFilter>('/api/saved-filters', {
        name: trimmed,
        page,
        filterJson,
      })
      onSaved(filter)
      onClose()
    } catch (e: unknown) {
      // Surface known error codes as inline messages
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === 'DUPLICATE_NAME') {
        setErr('A filter with that name exists.')
      } else if (msg === 'INVALID_NAME') {
        setErr('Name must be 1–64 characters.')
      } else {
        setErr(msg || 'Could not save filter. Try again.')
      }
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogHeader>
        <DialogTitle>Save filter</DialogTitle>
      </DialogHeader>
      <form onSubmit={(e) => void handleSubmit(e)}>
        <DialogBody>
          {err && (
            <span className="error" role="alert">
              {err}
            </span>
          )}
          <FieldLabel htmlFor="save-filter-name">
            Name
            <Input
              id="save-filter-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              required
              autoComplete="off"
              autoFocus
            />
          </FieldLabel>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  )
}
