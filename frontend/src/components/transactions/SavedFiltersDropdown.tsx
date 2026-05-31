import { useCallback, useEffect, useRef, useState } from 'react'
import { Bookmark, ChevronDown } from 'lucide-react'
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
import { useToast } from '@/components/ui/toast'
import { getJson, patchJson, postJson } from '../../lib/api'

export type SavedFilter = {
  id: number
  name: string
  page: string
  filterJson: Record<string, string | boolean | number | number[]>
  position: number
}

type Props = {
  /** filterJson shape of the current UI state */
  currentFilter: Record<string, string | boolean | number | number[]>
  /** Called with the filterJson when the user picks a saved filter */
  onApply: (filterJson: SavedFilter['filterJson']) => void
}

/** True when the two filter objects represent the same filter. */
function filterEquals(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keysA = Object.keys(a).filter((k) => {
    const v = a[k]
    return v !== '' && v !== false && !(Array.isArray(v) && v.length === 0)
  })
  const keysB = Object.keys(b).filter((k) => {
    const v = b[k]
    return v !== '' && v !== false && !(Array.isArray(v) && v.length === 0)
  })
  if (keysA.length !== keysB.length) return false
  return keysA.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

export function SavedFiltersDropdown({ currentFilter, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<SavedFilter[]>([])
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState(false)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { showToast } = useToast()

  const load = useCallback(async () => {
    setLoading(true)
    setLoadErr(false)
    try {
      const data = await getJson<SavedFilter[]>('/api/saved-filters?page=transactions')
      setFilters(data)
    } catch {
      setLoadErr(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  function applyFilter(f: SavedFilter) {
    setActiveId(f.id)
    setOpen(false)
    onApply(f.filterJson)
  }

  async function openSave() {
    setOpen(false)
    setSaveName('')
    setSaveErr(null)
    setSaveOpen(true)
  }

  async function submitSave() {
    const name = saveName.trim()
    if (!name) return
    setSaving(true)
    setSaveErr(null)
    try {
      const created = await postJson<SavedFilter>('/api/saved-filters', {
        name,
        page: 'transactions',
        filterJson: currentFilter,
      })
      setFilters((prev) => [...prev, created])
      setActiveId(created.id)
      setSaveOpen(false)
      showToast({ title: `Filter saved as '${name}'.` })
    } catch (err) {
      const body = err instanceof Error ? err.message : ''
      if (body.includes('DUPLICATE_NAME')) {
        setSaveErr('A filter with that name exists.')
      } else if (body.includes('INVALID_NAME')) {
        setSaveErr('Name must be 1–64 characters.')
      } else {
        setSaveErr("Couldn't save filter. Try again.")
      }
    } finally {
      setSaving(false)
    }
  }

  async function updateFilter(f: SavedFilter) {
    try {
      const updated = await patchJson<SavedFilter>(`/api/saved-filters/${f.id}`, {
        filterJson: currentFilter,
      })
      setFilters((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
      setActiveId(updated.id)
      setOpen(false)
      showToast({ title: `Updated '${f.name}'.` })
    } catch {
      showToast({ title: "Couldn't save filter. Try again." })
    }
  }

  const activeFilter = filters.find((f) => f.id === activeId) ?? null
  const isDirty = activeFilter != null && !filterEquals(currentFilter, activeFilter.filterJson)

  return (
    <>
      <div className="relative" ref={dropdownRef}>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <Bookmark className="size-3.5" aria-hidden />
          Saved filters
          {activeFilter && (
            <span className="ml-1 max-w-[100px] truncate text-xs text-muted-foreground">
              {activeFilter.name}
              {isDirty ? ' · modified' : ''}
            </span>
          )}
          <ChevronDown className="size-3 ml-0.5" aria-hidden />
        </Button>

        {open && (
          <div
            role="listbox"
            aria-label="Saved filters"
            className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-lg border border-border bg-card py-1 shadow-md"
          >
            <div className="px-3 py-1 text-xs font-semibold text-muted-foreground">
              Saved filters
            </div>

            {loading && (
              <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>
            )}

            {!loading && loadErr && (
              <div className="px-3 py-2 text-sm text-red-600">
                Couldn't load filters.{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => void load()}
                >
                  Retry
                </button>
              </div>
            )}

            {!loading && !loadErr && filters.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">No saved filters yet.</div>
            )}

            {!loading && !loadErr && filters.map((f) => {
              const isActive = f.id === activeId
              return (
                <button
                  key={f.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => applyFilter(f)}
                >
                  {isActive && <span className="text-primary">✓</span>}
                  <span className={isActive ? 'font-semibold' : ''}>{f.name}</span>
                </button>
              )
            })}

            <div className="mx-3 my-1 border-t border-border" />

            {activeFilter && isDirty && (
              <button
                type="button"
                className="flex w-full items-center px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => void updateFilter(activeFilter)}
              >
                Update '{activeFilter.name}'
              </button>
            )}

            <button
              type="button"
              className="flex w-full items-center px-3 py-2 text-left text-sm hover:bg-accent"
              onClick={() => void openSave()}
            >
              Save current filter…
            </button>
          </div>
        )}
      </div>

      <Dialog open={saveOpen} onOpenChange={(v) => { if (!v) setSaveOpen(false) }}>
        <DialogHeader>
          <DialogTitle>Save filter</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void submitSave() }}>
          <DialogBody>
            <FieldLabel htmlFor="save-filter-name">
              Name
              <Input
                id="save-filter-name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                maxLength={64}
                required
                autoComplete="off"
                autoFocus
              />
            </FieldLabel>
            {saveErr && (
              <p className="mt-1 text-sm text-red-600" role="alert">
                {saveErr}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !saveName.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </>
  )
}

