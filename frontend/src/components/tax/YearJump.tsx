import { forwardRef, useEffect, useId, useState } from 'react'
import { cn } from '@/lib/utils'

const HINT_KEY = 'tax.yearJumpHintSeen'

interface YearJumpProps {
  years: number[]
  value: number
  onChange: (year: number) => void
}

export const YearJump = forwardRef<HTMLInputElement, YearJumpProps>(
  function YearJump({ years, value, onChange }, ref) {
    const id = useId()
    const [query, setQuery] = useState('')
    const [open, setOpen] = useState(false)
    const [highlightIdx, setHighlightIdx] = useState(0)
    const [showHint, setShowHint] = useState(false)

    useEffect(() => {
      try {
        if (!localStorage.getItem(HINT_KEY)) {
          setShowHint(true)
          const t = setTimeout(() => setShowHint(false), 4000)
          localStorage.setItem(HINT_KEY, '1')
          return () => clearTimeout(t)
        }
      } catch {
        // localStorage unavailable
      }
    }, [])

    const filtered = years.filter((y) =>
      query === '' ? true : String(y).includes(query),
    )

    useEffect(() => {
      setHighlightIdx(0)
    }, [query])

    function select(y: number) {
      onChange(y)
      setQuery('')
      setOpen(false)
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        setOpen(true)
        return
      }
      if (!open) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (filtered[highlightIdx] !== undefined) select(filtered[highlightIdx])
      } else if (e.key === 'Escape') {
        setQuery('')
        setOpen(false)
      }
    }

    return (
      <div className="relative inline-block">
        <label htmlFor={id} className="text-sm font-medium">
          Year{' '}
        </label>
        <div className="relative inline-flex">
          <input
            ref={ref}
            id={id}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={`${id}-list`}
            aria-activedescendant={
              open && filtered[highlightIdx] !== undefined
                ? `${id}-opt-${filtered[highlightIdx]}`
                : undefined
            }
            aria-label="Tax year (Cmd+K to focus)"
            title="Tax year — press Cmd+K (or Ctrl+K) to jump here from anywhere"
            className={cn(
              'w-24 rounded border border-input bg-background px-2 py-0.5 text-sm',
              'focus:outline-none focus:ring-1 focus:ring-ring',
            )}
            placeholder={String(value)}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              setTimeout(() => setOpen(false), 150)
            }}
            onKeyDown={handleKeyDown}
          />
          {open && filtered.length > 0 && (
            <ul
              id={`${id}-list`}
              role="listbox"
              aria-label="Tax years"
              className={cn(
                'absolute left-0 top-full z-50 mt-1 max-h-48 w-24 overflow-auto',
                'rounded border border-border bg-popover shadow-md',
              )}
            >
              {filtered.map((y, i) => (
                <li
                  key={y}
                  id={`${id}-opt-${y}`}
                  role="option"
                  aria-selected={y === value}
                  className={cn(
                    'cursor-pointer px-2 py-1 text-sm',
                    i === highlightIdx
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50',
                    y === value && i !== highlightIdx && 'font-medium',
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    select(y)
                  }}
                  onMouseEnter={() => setHighlightIdx(i)}
                >
                  {y}
                </li>
              ))}
            </ul>
          )}
        </div>
        {showHint && (
          <span className="ml-2 text-xs text-muted-foreground">
            Press Cmd-K to jump to a year.
          </span>
        )}
      </div>
    )
  },
)
