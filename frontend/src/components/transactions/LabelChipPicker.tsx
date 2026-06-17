import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { postJson } from '../../lib/api'
import type { Label, TransactionLabelRef } from '../../types/api'

const LABEL_NAME_MAX = 32
const MAX_DROPDOWN = 10

type Props = {
  transactionId: number
  /** Labels currently applied to the transaction. */
  value: TransactionLabelRef[]
  /** All labels available to the household (for the typeahead dropdown). */
  availableLabels: Label[]
  /** Called with the new applied-label set after a successful apply/remove. */
  onChange: (labels: TransactionLabelRef[]) => void
  /** Called after a new label is created so callers can refresh their cache. */
  onLabelsMutated?: () => void
}

/**
 * Inline chip-style label picker for the Transaction detail view (issue #270).
 *
 * - Applied labels render as removable pills (× on hover, or always visible
 *   for keyboard/touch users).
 * - Typing filters existing labels into a dropdown (≤10, keyboard-navigable).
 * - Enter applies the highlighted match, or — if the typed name matches no
 *   existing label (case-insensitively) — creates it and applies it in one
 *   action (AC #10).
 * - Backspace on an empty input removes the last applied label.
 * - Names longer than 32 chars surface an inline error without an API call.
 *
 * All mutations go through POST /api/transactions/:id/labels with the FULL
 * desired set, so the server reconciles add/remove atomically.
 */
export function LabelChipPicker({
  transactionId,
  value,
  availableLabels,
  onChange,
  onLabelsMutated,
}: Props) {
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const appliedIds = useMemo(() => new Set(value.map((l) => l.id)), [value])

  // Existing labels that match the query and aren't already applied.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return availableLabels
      .filter((l) => !appliedIds.has(l.id))
      .filter((l) => (q ? l.name.toLowerCase().includes(q) : true))
      .slice(0, MAX_DROPDOWN)
  }, [availableLabels, appliedIds, query])

  async function persist(next: TransactionLabelRef[]): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const res = await postJson<{ labels: TransactionLabelRef[] }>(
        `/api/transactions/${transactionId}/labels`,
        { labelIds: next.map((l) => l.id) },
      )
      onChange(res.labels)
    } catch {
      setError("Couldn't save label. Try again.")
    } finally {
      setBusy(false)
    }
  }

  async function applyExisting(label: TransactionLabelRef): Promise<void> {
    if (appliedIds.has(label.id)) return
    setQuery('')
    setHighlight(0)
    await persist([...value, { id: label.id, name: label.name }])
  }

  async function applyTypedName(raw: string): Promise<void> {
    const name = raw.trim()
    if (name.length === 0) return
    if (name.length > LABEL_NAME_MAX) {
      setError('Label names must be 32 characters or fewer.')
      return
    }
    // Case-insensitive match against existing labels — apply rather than
    // create a duplicate (the edge case in the issue's UX notes).
    const existing = availableLabels.find(
      (l) => l.name.toLowerCase() === name.toLowerCase(),
    )
    if (existing) {
      await applyExisting(existing)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await postJson<Label>('/api/labels', { name })
      setQuery('')
      setHighlight(0)
      onLabelsMutated?.()
      await persist([...value, { id: created.id, name: created.name }])
    } catch {
      setError("Couldn't save label. Try again.")
      setBusy(false)
    }
  }

  async function removeLabel(id: number): Promise<void> {
    await persist(value.filter((l) => l.id !== id))
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (matches.length > 0 && query.trim().length > 0 && highlight < matches.length) {
        const picked = matches[highlight]
        // If the highlighted match equals the typed text exactly (case-insensitive),
        // or the user is navigating matches, apply it.
        void applyExisting(picked)
      } else {
        void applyTypedName(query)
      }
    } else if (e.key === 'Backspace' && query.length === 0 && value.length > 0) {
      e.preventDefault()
      void removeLabel(value[value.length - 1].id)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, Math.max(0, matches.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Escape') {
      setQuery('')
      setHighlight(0)
    }
  }

  const showDropdown = query.trim().length > 0 && matches.length > 0

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((label) => (
          <span
            key={label.id}
            className="group inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
          >
            {label.name}
            <Button
              type="button"
              variant="ghost"
              aria-label={`Remove ${label.name}`}
              className="text-muted-foreground hover:text-foreground"
              disabled={busy}
              onClick={() => void removeLabel(label.id)}
            >
              ×
            </Button>
          </span>
        ))}
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="Add label…"
            aria-label="Add label"
            className="min-w-[7rem] border-none bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            disabled={busy}
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
              if (error) setError(null)
            }}
            onKeyDown={onKeyDown}
          />
          {showDropdown && (
            <ul
              role="listbox"
              className="absolute left-0 top-6 z-10 max-h-60 w-48 overflow-auto rounded-md border border-border bg-popover py-1 shadow-md"
            >
              {matches.map((label, i) => (
                <li key={label.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    role="option"
                    aria-selected={i === highlight}
                    className={
                      i === highlight
                        ? 'block w-full px-2 py-1 text-left text-xs bg-muted'
                        : 'block w-full px-2 py-1 text-left text-xs hover:bg-muted'
                    }
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => void applyExisting(label)}
                  >
                    {label.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {error && (
        <span className="text-xs text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
