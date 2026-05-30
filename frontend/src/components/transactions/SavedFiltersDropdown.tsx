import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { deleteReq, getJson } from '../../lib/api'
import { SaveFilterModal, type SavedFilter } from './SaveFilterModal'

interface Props {
  currentParams: URLSearchParams
  onApply: (filterJson: Record<string, unknown>) => void
  page?: string
}

/**
 * Dropdown for applying and saving named filter presets (issue #272).
 *
 * - Lazy-fetches presets on first open, caches until remount.
 * - Shows "Save current filter…" item that opens SaveFilterModal.
 * - Delete button per item with window.confirm guard.
 * - Tracks which preset (if any) matches the current URL params.
 */
export function SavedFiltersDropdown({
  currentParams,
  onApply,
  page = 'transactions',
}: Props) {
  const [open, setOpen] = useState(false)
  const [filters, setFilters] = useState<SavedFilter[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [appliedFilterId, setAppliedFilterId] = useState<number | null>(null)
  const [appliedParams, setAppliedParams] = useState<URLSearchParams | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function fetchFilters() {
    if (filters !== null) return // already cached
    setLoading(true)
    setError(false)
    try {
      const rows = await getJson<SavedFilter[]>(`/api/saved-filters?page=${encodeURIComponent(page)}`)
      setFilters(rows)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  function handleToggle() {
    const next = !open
    setOpen(next)
    if (next) {
      void fetchFilters()
    }
  }

  function applyFilter(filter: SavedFilter) {
    setAppliedFilterId(filter.id)
    // Snapshot the params that were applied
    const applied = new URLSearchParams()
    for (const [k, v] of Object.entries(filter.filterJson)) {
      if (v != null && String(v) !== '') applied.set(k, String(v))
    }
    setAppliedParams(applied)
    onApply(filter.filterJson)
    setOpen(false)
  }

  async function deleteFilter(filter: SavedFilter, e: React.MouseEvent) {
    e.stopPropagation()
    if (!window.confirm(`Delete saved filter "${filter.name}"?`)) return
    try {
      await deleteReq(`/api/saved-filters/${filter.id}`)
      setFilters((prev) => prev?.filter((f) => f.id !== filter.id) ?? null)
      if (appliedFilterId === filter.id) {
        setAppliedFilterId(null)
        setAppliedParams(null)
      }
    } catch {
      // silent — user can retry
    }
  }

  function onSaved(filter: SavedFilter) {
    setFilters((prev) => (prev ? [...prev, filter] : [filter]))
  }

  // Compute button label
  let buttonLabel = 'Saved filters'
  if (appliedFilterId !== null && filters) {
    const appliedFilter = filters.find((f) => f.id === appliedFilterId)
    if (appliedFilter) {
      buttonLabel = appliedFilter.name
      // Check if current params differ from what was applied
      if (appliedParams) {
        const currentSorted = [...currentParams.entries()].sort().toString()
        const appliedSorted = [...appliedParams.entries()].sort().toString()
        if (currentSorted !== appliedSorted) {
          buttonLabel += ' · modified'
        }
      }
    }
  }

  // If there's an error fetching, hide the dropdown entirely
  if (error) return null

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={handleToggle}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {buttonLabel} <span aria-hidden style={{ marginLeft: '4px' }}>&#x25BE;</span>
      </Button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 50,
            minWidth: '200px',
            marginTop: '4px',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            background: 'var(--card)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            padding: '4px 0',
          }}
        >
          {loading ? (
            <div style={{ padding: '8px 12px', color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>
              Loading…
            </div>
          ) : filters && filters.length === 0 ? (
            <div style={{ padding: '8px 12px', color: 'var(--muted-foreground)', fontSize: '0.875rem' }}>
              No saved filters yet.
            </div>
          ) : (
            filters?.map((filter) => (
              <div
                key={filter.id}
                role="menuitem"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '6px 12px',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  gap: '8px',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = 'var(--muted)'
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = ''
                }}
              >
                <span
                  style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  onClick={() => applyFilter(filter)}
                >
                  {filter.name}
                </span>
                <button
                  type="button"
                  aria-label={`Delete filter "${filter.name}"`}
                  onClick={(e) => void deleteFilter(filter, e)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '0 2px',
                    color: 'var(--muted-foreground)',
                    fontSize: '0.875rem',
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                >
                  &#x2715;
                </button>
              </div>
            ))
          )}

          <div
            role="separator"
            style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }}
          />
          <div
            role="menuitem"
            style={{
              padding: '6px 12px',
              cursor: 'pointer',
              fontSize: '0.875rem',
              color: 'var(--accent)',
            }}
            onClick={() => {
              setOpen(false)
              setShowSaveModal(true)
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'var(--muted)'
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = ''
            }}
          >
            Save current filter…
          </div>
        </div>
      )}

      {showSaveModal && (
        <SaveFilterModal
          page={page}
          filterJson={Object.fromEntries(currentParams.entries())}
          onSaved={(filter) => {
            onSaved(filter)
            setShowSaveModal(false)
          }}
          onClose={() => setShowSaveModal(false)}
        />
      )}
    </div>
  )
}
