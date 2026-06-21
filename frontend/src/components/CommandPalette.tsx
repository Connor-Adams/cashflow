/**
 * Finance command palette (issue #237).
 *
 * Global ⌘K / Ctrl+K overlay listing finance commands. Search-as-you-type,
 * arrow-key navigation, Enter to run, Esc to close.
 *
 * Composition:
 *   - `useCommandPalette()` hook (in `@/hooks/useCommandPalette`) owns
 *     open/close state and the global keyboard listener.
 *   - `<CommandPalette>` is the controlled UI: pass `open` + `onOpenChange`.
 *   - `<GlobalCommandPalette>` wires the hook into `<Layout>` so every
 *     authenticated page gets the palette for free.
 *
 * Behavior contract (mirrors ReviewInbox shortcut discipline):
 *   - When focus is inside an input/textarea/select/contenteditable, the
 *     global ⌘K still works (it's a chord, not a single key).
 *   - Closing the palette restores focus to whatever was focused before
 *     it opened.
 *   - Commands run via react-router navigate. Contextual commands are
 *     filtered against the live URL pathname.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '@connor-adams/designsystem'
import { useCommandPalette } from '@/hooks/useCommandPalette'
import {
  filterCommands,
  groupCommandsByCategory,
  type Command,
} from '@/lib/commands'

type CommandPaletteProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Optional registry override (for tests). Defaults to the built-in
   * COMMANDS array consumed by `filterCommands`.
   */
  registry?: Command[]
  /**
   * Optional pathname override (for tests). Defaults to the live router
   * `useLocation().pathname`.
   */
  pathname?: string
  /**
   * Optional onRun callback fired after the navigate (test seam +
   * future analytics hook).
   */
  onRun?: (command: Command) => void
}

const MAX_RESULTS = 50

export function CommandPalette({
  open,
  onOpenChange,
  registry,
  pathname: pathnameOverride,
  onRun,
}: CommandPaletteProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const pathname = pathnameOverride ?? location.pathname
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const reactId = useId()
  const listboxId = `command-palette-list-${reactId}`

  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const visible = useMemo(
    () =>
      filterCommands({
        query,
        pathname,
        registry,
        limit: MAX_RESULTS,
      }),
    [pathname, query, registry],
  )

  // Compute a flat index map alongside the grouped layout so we can
  // render grouped sections but still address each item by its position
  // in the visible list. Memoized so the indexes are stable across
  // re-renders driven by `activeIndex` alone.
  const groups = useMemo(() => {
    const raw = groupCommandsByCategory(visible)
    let counter = 0
    return raw.map((group) => ({
      category: group.category,
      commands: group.commands.map((cmd) => ({ cmd, index: counter++ })),
    }))
  }, [visible])

  // Reset query + active index whenever the palette transitions to open.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [open])

  // Auto-focus the input on open, restore prior focus on close.
  useEffect(() => {
    if (open) {
      previousFocusRef.current =
        (document.activeElement as HTMLElement | null) ?? null
      // Defer to allow portal mount.
      const id = window.setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
      return () => window.clearTimeout(id)
    }
    const prev = previousFocusRef.current
    if (prev && typeof prev.focus === 'function') {
      try {
        prev.focus()
      } catch {
        // ignore
      }
    }
    return undefined
  }, [open])

  // Body scroll lock + Escape close (Escape is also caught by the input,
  // but listening at document level catches it when focus drifts).
  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    function onEsc(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', onEsc, true)
    return () => {
      document.body.style.overflow = prevOverflow
      document.removeEventListener('keydown', onEsc, true)
    }
  }, [open, onOpenChange])

  // Clamp active index when results shrink.
  useEffect(() => {
    if (activeIndex >= visible.length) {
      setActiveIndex(Math.max(0, visible.length - 1))
    }
  }, [activeIndex, visible.length])

  // Scroll active item into view.
  useEffect(() => {
    if (!open) return
    const container = listRef.current
    if (!container) return
    const el = container.querySelector<HTMLElement>(
      `[data-command-index="${activeIndex}"]`,
    )
    // jsdom doesn't implement scrollIntoView; guard for tests.
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIndex, open])

  const runCommand = useCallback(
    (command: Command) => {
      onOpenChange(false)
      navigate(command.destination)
      onRun?.(command)
    },
    [navigate, onOpenChange, onRun],
  )

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((idx) =>
        visible.length === 0 ? 0 : Math.min(idx + 1, visible.length - 1),
      )
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((idx) => Math.max(0, idx - 1))
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(Math.max(0, visible.length - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = visible[activeIndex]
      if (target) runCommand(target)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
      return
    }
  }

  function handleBackdropMouseDown(
    event: React.MouseEvent<HTMLDivElement>,
  ) {
    if (event.target === event.currentTarget) {
      onOpenChange(false)
    }
  }

  if (!open) return null
  if (typeof document === 'undefined') return null

  const activeId =
    visible[activeIndex] != null
      ? `command-palette-option-${visible[activeIndex].id}`
      : undefined

  const portalNode = (
    <div
      data-slot="command-palette-overlay"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-20"
      onMouseDown={handleBackdropMouseDown}
      data-testid="command-palette-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-xl rounded-lg border border-border bg-card shadow-lg outline-none"
        style={{ color: 'var(--fg)' }}
        data-testid="command-palette"
      >
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Icon name="search" aria-hidden="true" className="h-4 w-4 opacity-70" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleInputKeyDown}
            placeholder="Search commands..."
            aria-label="Search commands"
            aria-controls={listboxId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            className="h-9 w-full rounded-md border border-input bg-background/70 px-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 border-0 shadow-none focus-visible:ring-0"
            data-testid="command-palette-input"
          />
        </div>

        {visible.length === 0 ? (
          <div
            className="p-6 text-center text-sm text-muted-foreground"
            role="status"
            data-testid="command-palette-empty"
          >
            No commands match &ldquo;{query}&rdquo;.
          </div>
        ) : (
          <div
            id={listboxId}
            role="listbox"
            aria-label="Commands"
            className="max-h-[60vh] overflow-y-auto p-1"
            ref={listRef}
          >
            {groups.map((group) => (
              <div key={group.category} role="presentation">
                <div
                  className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {group.category}
                </div>
                {group.commands.map(({ cmd, index }) => {
                  const isActive = index === activeIndex
                  return (
                    <button
                      key={cmd.id}
                      data-slot="listbox-option"
                      id={`command-palette-option-${cmd.id}`}
                      role="option"
                      type="button"
                      aria-selected={isActive}
                      data-command-index={index}
                      data-active={isActive ? 'true' : undefined}
                      data-testid={`command-palette-item-${cmd.id}`}
                      className={
                        isActive
                          ? 'flex w-full flex-col items-start gap-0.5 rounded-md bg-foreground/10 px-3 py-2 text-left text-sm outline-none'
                          : 'flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-foreground/5'
                      }
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => runCommand(cmd)}
                    >
                      <span className="font-medium">{cmd.label}</span>
                      {cmd.description ? (
                        <span
                          className="text-xs text-muted-foreground"
                        >
                          {cmd.description}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}

        <div
          className="flex items-center justify-between border-t border-border px-3 py-2 text-[11px] text-muted-foreground"
        >
          <span>
            <kbd className="font-mono">↑</kbd>{' '}
            <kbd className="font-mono">↓</kbd> navigate ·{' '}
            <kbd className="font-mono">Enter</kbd> run ·{' '}
            <kbd className="font-mono">Esc</kbd> close
          </span>
          <span>
            <kbd className="font-mono">⌘K</kbd> /{' '}
            <kbd className="font-mono">Ctrl+K</kbd>
          </span>
        </div>
      </div>
    </div>
  )

  return createPortal(portalNode, document.body)
}

/**
 * Convenience wrapper for `<Layout>`: owns the hook + renders the
 * palette. Drop into the layout tree to get global ⌘K everywhere.
 */
export function GlobalCommandPalette() {
  const { open, setOpen } = useCommandPalette()
  return <CommandPalette open={open} onOpenChange={setOpen} />
}
