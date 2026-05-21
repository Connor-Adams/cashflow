import React, { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Enable React 19 act() environment for interactive tests in this file.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { buildCsv, escapeCsvField } from '../../lib/csv'
import { Alert } from './alert'
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useConfirm,
} from './dialog'
import { EmptyState } from './empty-state'
import { FilterBar, type QuickRange } from './filter-bar'
import { Label } from './label'
import { NativeSelect, NativeSelectOption } from './native-select'
import { PageHeader } from './page-header'
import { Skeleton, SkeletonRow, SkeletonText } from './skeleton'
import { StatCard } from './stat-card'
import { ToastProvider, useToast } from './toast'

describe('local design-system primitives', () => {
  it('renders labeled native selects with compact sizing', () => {
    const html = renderToStaticMarkup(
      <Label>
        Status
        <NativeSelect size="sm" defaultValue="open">
          <NativeSelectOption value="open">Open</NativeSelectOption>
          <NativeSelectOption value="closed">Closed</NativeSelectOption>
        </NativeSelect>
      </Label>
    )

    expect(html).toContain('data-slot="label"')
    expect(html).toContain('data-slot="native-select"')
    expect(html).toContain('Open')
  })

  it('renders page headers with title, description, and actions', () => {
    const html = renderToStaticMarkup(
      <PageHeader
        title="Review Inbox"
        description="Clear imported transactions."
        actions={<button type="button">Refresh</button>}
      />
    )

    expect(html).toContain('<h1')
    expect(html).toContain('Review Inbox')
    expect(html).toContain('Clear imported transactions.')
    expect(html).toContain('Refresh')
  })

  it('renders stat and empty-state primitives', () => {
    const html = renderToStaticMarkup(
      <>
        <StatCard label="Unreviewed" value="6" hint="Open transactions" />
        <EmptyState title="No rows" description="Everything is reviewed." />
      </>
    )

    expect(html).toContain('Unreviewed')
    expect(html).toContain('Open transactions')
    expect(html).toContain('No rows')
    expect(html).toContain('Everything is reviewed.')
  })

  it('marks StatCard delta with data-sign=positive for "+" prefixed values', () => {
    const html = renderToStaticMarkup(
      <StatCard label="Spend" value="$100" hint="this period" delta="+12.34" />
    )
    expect(html).toContain('data-slot="stat-card-delta"')
    expect(html).toContain('data-sign="positive"')
    expect(html).toContain('+12.34')
  })

  it('marks StatCard delta with data-sign=negative for "-" prefixed values', () => {
    const html = renderToStaticMarkup(
      <StatCard label="Spend" value="$100" hint="this period" delta="-5.00" />
    )
    expect(html).toContain('data-slot="stat-card-delta"')
    expect(html).toContain('data-sign="negative"')
    expect(html).toContain('-5.00')
  })

  it('marks StatCard delta with data-sign=neutral for zero or non-numeric values', () => {
    const zero = renderToStaticMarkup(
      <StatCard label="Spend" value="$100" hint="this period" delta="0" />
    )
    expect(zero).toContain('data-sign="neutral"')

    const text = renderToStaticMarkup(
      <StatCard label="Months" value="3" hint="—" delta="last quarter" />
    )
    expect(text).toContain('data-sign="neutral"')
  })

  // metricKind controls the styling tone independently of the parsed sign so
  // a positive delta on a 'spend' metric reads as bad (red), and 'neutral'
  // metrics stay muted regardless of direction.
  it('colors StatCard delta tone based on metricKind for positive and negative deltas', () => {
    // gain: up → positive (green), down → negative (red)
    const gainUp = renderToStaticMarkup(
      <StatCard label="Refunds" value="$10" delta="+5" metricKind="gain" />
    )
    expect(gainUp).toContain('data-sign="positive"')
    expect(gainUp).toContain('data-tone="positive"')
    expect(gainUp).toContain('data-metric-kind="gain"')

    const gainDown = renderToStaticMarkup(
      <StatCard label="Refunds" value="$10" delta="-5" metricKind="gain" />
    )
    expect(gainDown).toContain('data-sign="negative"')
    expect(gainDown).toContain('data-tone="negative"')

    // spend: up → negative (red), down → positive (green)
    const spendUp = renderToStaticMarkup(
      <StatCard label="Spend" value="$100" delta="+12.34" metricKind="spend" />
    )
    expect(spendUp).toContain('data-sign="positive"')
    expect(spendUp).toContain('data-tone="negative"')
    expect(spendUp).toContain('data-metric-kind="spend"')

    const spendDown = renderToStaticMarkup(
      <StatCard label="Spend" value="$100" delta="-7" metricKind="spend" />
    )
    expect(spendDown).toContain('data-sign="negative"')
    expect(spendDown).toContain('data-tone="positive"')

    // neutral: always muted regardless of sign
    const neutralUp = renderToStaticMarkup(
      <StatCard label="Transactions" value="42" delta="+3" metricKind="neutral" />
    )
    expect(neutralUp).toContain('data-sign="positive"')
    expect(neutralUp).toContain('data-tone="neutral"')
    expect(neutralUp).toContain('data-metric-kind="neutral"')

    const neutralDown = renderToStaticMarkup(
      <StatCard label="Transactions" value="42" delta="-3" metricKind="neutral" />
    )
    expect(neutralDown).toContain('data-sign="negative"')
    expect(neutralDown).toContain('data-tone="neutral"')
  })

  it('defaults StatCard metricKind to gain when prop is omitted', () => {
    const html = renderToStaticMarkup(
      <StatCard label="Refunds" value="$10" delta="+5" />
    )
    expect(html).toContain('data-metric-kind="gain"')
    expect(html).toContain('data-tone="positive"')
  })

  it('renders Alert with error variant and role=alert', () => {
    const html = renderToStaticMarkup(
      <Alert variant="error" title="Upload failed">
        Three rows could not be parsed.
      </Alert>
    )
    expect(html).toContain('data-slot="alert"')
    expect(html).toContain('data-variant="error"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('Upload failed')
    expect(html).toContain('Three rows could not be parsed.')
  })

  it('renders Alert with warning/info/success using role=status', () => {
    for (const variant of ['warning', 'info', 'success'] as const) {
      const html = renderToStaticMarkup(
        <Alert variant={variant} title={`${variant} title`}>
          body
        </Alert>
      )
      expect(html).toContain(`data-variant="${variant}"`)
      expect(html).toContain('role="status"')
    }
  })

  it('renders Alert action when provided', () => {
    const html = renderToStaticMarkup(
      <Alert variant="info" title="Heads up" action={<button type="button">Dismiss</button>}>
        Something happened.
      </Alert>
    )
    expect(html).toContain('Dismiss')
    expect(html).toContain('Something happened.')
  })
})

// --- DOM test harness for interactive primitives -----------------------------

type Harness = {
  container: HTMLElement
  root: Root
  render: (node: React.ReactNode) => Promise<void>
  unmount: () => Promise<void>
}

function createHarness(): Harness {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return {
    container,
    root,
    async render(node: React.ReactNode) {
      await act(async () => {
        root.render(node)
      })
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

function dispatchKey(target: EventTarget, key: string, shiftKey = false) {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
}

function dispatchMouseDown(target: EventTarget) {
  const event = new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
}

function dispatchClick(target: EventTarget) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
}

// React tracks input/select values via a private tracker; to make React fire
// its synthetic onChange we must set the value through the native prototype
// setter (so React's tracker sees the change) and then dispatch an `input`
// event. See React's ReactDOMInput#updateValueIfChanged.
function setNativeValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string
) {
  const proto =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) {
    setter.call(element, value)
  } else {
    element.value = value
  }
}

// Captures the useToast() API by rendering a ToastProvider with a Capture child
// that resolves a Promise with the API via a callback prop. This avoids
// reassigning module-level variables from inside components (which the React
// Compiler lint blocks).
function captureToastApi(harness: Harness): Promise<ReturnType<typeof useToast>> {
  return new Promise((resolve) => {
    function Capture({ onApi }: { onApi: (api: ReturnType<typeof useToast>) => void }) {
      const api = useToast()
      const calledRef = useRef(false)
      React.useEffect(() => {
        if (calledRef.current) return
        calledRef.current = true
        onApi(api)
      }, [api, onApi])
      return null
    }
    void harness.render(
      <ToastProvider>
        <Capture onApi={resolve} />
      </ToastProvider>
    )
  })
}

describe('Dialog primitive', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(async () => {
    await harness.unmount()
    // Clean up any lingering portal nodes
    document.body
      .querySelectorAll('[data-slot="dialog-overlay"]')
      .forEach((node) => node.remove())
  })

  it('renders nothing when closed and renders portal content when open', async () => {
    await harness.render(
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogHeader>
          <DialogTitle>Closed</DialogTitle>
        </DialogHeader>
      </Dialog>
    )
    expect(document.querySelector('[data-slot="dialog"]')).toBeNull()

    await harness.render(
      <Dialog open onOpenChange={() => {}}>
        <DialogHeader>
          <DialogTitle>Hello</DialogTitle>
        </DialogHeader>
        <DialogBody>Body text</DialogBody>
      </Dialog>
    )
    const dialog = document.querySelector('[data-slot="dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('role')).toBe('dialog')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    expect(document.body.textContent).toContain('Hello')
    expect(document.body.textContent).toContain('Body text')
  })

  it('calls onOpenChange(false) when Escape is pressed', async () => {
    const onOpenChange = vi.fn()
    await harness.render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogHeader>
          <DialogTitle>Esc test</DialogTitle>
        </DialogHeader>
      </Dialog>
    )
    await act(async () => {
      dispatchKey(document, 'Escape')
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('calls onOpenChange(false) when backdrop is clicked', async () => {
    const onOpenChange = vi.fn()
    await harness.render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogHeader>
          <DialogTitle>Backdrop test</DialogTitle>
        </DialogHeader>
      </Dialog>
    )
    const overlay = document.querySelector(
      '[data-slot="dialog-overlay"]'
    ) as HTMLElement | null
    expect(overlay).not.toBeNull()
    await act(async () => {
      dispatchMouseDown(overlay!)
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not dismiss on backdrop click when dismissOnBackdropClick is false', async () => {
    const onOpenChange = vi.fn()
    await harness.render(
      <Dialog open onOpenChange={onOpenChange} dismissOnBackdropClick={false}>
        <DialogHeader>
          <DialogTitle>No backdrop</DialogTitle>
        </DialogHeader>
      </Dialog>
    )
    const overlay = document.querySelector(
      '[data-slot="dialog-overlay"]'
    ) as HTMLElement | null
    await act(async () => {
      dispatchMouseDown(overlay!)
    })
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('traps focus inside the dialog on Tab', async () => {
    function Harnessed() {
      const ref = useRef<HTMLButtonElement>(null)
      return (
        <Dialog open onOpenChange={() => {}} initialFocusRef={ref}>
          <DialogHeader>
            <DialogTitle>Focus trap</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <button type="button" ref={ref}>
              First
            </button>
            <button type="button">Last</button>
          </DialogFooter>
        </Dialog>
      )
    }
    await harness.render(<Harnessed />)
    // Auto-focus is deferred via setTimeout(0); wait for it to land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    const buttons = document.querySelectorAll(
      '[data-slot="dialog"] button'
    ) as NodeListOf<HTMLButtonElement>
    expect(buttons.length).toBe(2)
    const first = buttons[0]
    const last = buttons[1]
    expect(document.activeElement).toBe(first)

    // Tab from last should wrap to first.
    last.focus()
    await act(async () => {
      dispatchKey(document, 'Tab')
    })
    expect(document.activeElement).toBe(first)

    // Shift+Tab from first should wrap to last.
    first.focus()
    await act(async () => {
      dispatchKey(document, 'Tab', true)
    })
    expect(document.activeElement).toBe(last)
  })

  it('useConfirm resolves true on confirm and false on cancel/escape', async () => {
    function Host({ onResult }: { onResult: (v: boolean) => void }) {
      const confirm = useConfirm()
      const onResultRef = useRef(onResult)
      React.useEffect(() => {
        onResultRef.current = onResult
      }, [onResult])
      return (
        <>
          <button
            type="button"
            onClick={() => {
              confirm({ title: 'Sure?', confirmLabel: 'Yes', cancelLabel: 'No' }).then(
                (value) => onResultRef.current(value)
              )
            }}
          >
            Open
          </button>
          {confirm.dialog}
        </>
      )
    }

    const results: boolean[] = []
    await harness.render(<Host onResult={(v) => results.push(v)} />)
    const openBtn = harness.container.querySelector('button') as HTMLButtonElement

    // Case 1: clicking confirm resolves true
    await act(async () => {
      dispatchClick(openBtn)
    })
    const yesBtn = Array.from(
      document.querySelectorAll('[data-slot="dialog"] button')
    ).find((b) => b.textContent === 'Yes') as HTMLButtonElement | undefined
    expect(yesBtn).not.toBeUndefined()
    await act(async () => {
      dispatchClick(yesBtn!)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(results[0]).toBe(true)

    // Case 2: clicking cancel resolves false
    await act(async () => {
      dispatchClick(openBtn)
    })
    const noBtn = Array.from(
      document.querySelectorAll('[data-slot="dialog"] button')
    ).find((b) => b.textContent === 'No') as HTMLButtonElement | undefined
    expect(noBtn).not.toBeUndefined()
    await act(async () => {
      dispatchClick(noBtn!)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(results[1]).toBe(false)

    // Case 3: Escape resolves false
    await act(async () => {
      dispatchClick(openBtn)
    })
    await act(async () => {
      dispatchKey(document, 'Escape')
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(results[2]).toBe(false)
  })
})

describe('Toast primitive', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await harness.unmount()
    document.body
      .querySelectorAll('[data-slot="toast-viewport"]')
      .forEach((node) => node.remove())
  })

  it('appears on showToast and dismisses on action click', async () => {
    const api = await captureToastApi(harness)
    const onAction = vi.fn()
    await act(async () => {
      api.showToast({
        title: 'Saved',
        action: { label: 'Undo', onClick: onAction },
      })
    })
    // Advance fake timers so any rAF/setTimeout-driven mounts settle.
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    const toastEl = document.querySelector('[data-slot="toast"]')
    expect(toastEl).not.toBeNull()
    expect(toastEl?.textContent).toContain('Saved')
    expect(toastEl?.textContent).toContain('Undo')

    const actionBtn = document.querySelector(
      '[data-slot="toast-action"]'
    ) as HTMLButtonElement | null
    expect(actionBtn).not.toBeNull()
    await act(async () => {
      dispatchClick(actionBtn!)
    })
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it('auto-dismisses after duration', async () => {
    const api = await captureToastApi(harness)
    await act(async () => {
      api.showToast({ title: 'Hi', durationMs: 100 })
    })
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    expect(document.querySelector('[data-slot="toast"]')).not.toBeNull()
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(document.querySelector('[data-slot="toast"]')).toBeNull()
  })

  it('uses role=alert for destructive variant', async () => {
    const api = await captureToastApi(harness)
    await act(async () => {
      api.showToast({ title: 'Oh no', variant: 'destructive', durationMs: Infinity })
    })
    await act(async () => {
      vi.advanceTimersByTime(50)
    })
    const toastEl = document.querySelector('[data-slot="toast"]')
    expect(toastEl?.getAttribute('role')).toBe('alert')
  })
})

describe('Skeleton primitive', () => {
  it('renders with pulse class', () => {
    const html = renderToStaticMarkup(<Skeleton className="h-4 w-20" />)
    expect(html).toContain('animate-pulse')
    expect(html).toContain('data-slot="skeleton"')
    expect(html).toContain('h-4')
    expect(html).toContain('w-20')
  })

  it('renders SkeletonText with the requested number of lines', () => {
    const html = renderToStaticMarkup(<SkeletonText lines={4} />)
    const matches = html.match(/data-slot="skeleton"/g) ?? []
    expect(matches.length).toBe(4)
  })

  it('renders SkeletonRow with the requested number of cells', () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <SkeletonRow cols={3} />
        </tbody>
      </table>
    )
    const cellMatches = html.match(/<td/g) ?? []
    expect(cellMatches.length).toBe(3)
    expect(html).toContain('animate-pulse')
  })
})

describe('FilterBar primitive', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(async () => {
    await harness.unmount()
  })

  const sampleRanges: QuickRange[] = [
    { key: '30d', label: '30 days', from: '2025-04-17', to: '2025-05-17' },
    { key: '90d', label: '90 days', from: '2025-02-16', to: '2025-05-17' },
    { key: 'all', label: 'All time', from: '', to: '' },
  ]

  it('renders currency select, date inputs, and quick-range buttons', () => {
    const html = renderToStaticMarkup(
      <FilterBar
        currency="CAD"
        onCurrencyChange={() => {}}
        availableCurrencies={['CAD', 'USD']}
        dateFrom="2025-01-01"
        dateTo="2025-05-17"
        onDateChange={() => {}}
        quickRanges={sampleRanges}
      />
    )

    expect(html).toContain('data-slot="filter-bar"')
    expect(html).toContain('data-slot="native-select"')
    expect(html).toContain('All currencies')
    expect(html).toContain('CAD')
    expect(html).toContain('USD')
    // Two date inputs (from + to)
    const dateMatches = html.match(/type="date"/g) ?? []
    expect(dateMatches.length).toBe(2)
    expect(html).toContain('30 days')
    expect(html).toContain('90 days')
    expect(html).toContain('All time')
  })

  it('renders a free-text currency input when availableCurrencies is omitted', () => {
    const html = renderToStaticMarkup(
      <FilterBar
        currency="CAD"
        onCurrencyChange={() => {}}
        dateFrom=""
        dateTo=""
        onDateChange={() => {}}
      />
    )
    expect(html).toContain('data-slot="filter-bar"')
    expect(html).not.toContain('data-slot="native-select"')
    expect(html).toContain('placeholder="CAD"')
  })

  it('fires onCurrencyChange when the select changes', async () => {
    const onCurrencyChange = vi.fn()
    await harness.render(
      <FilterBar
        currency="CAD"
        onCurrencyChange={onCurrencyChange}
        availableCurrencies={['CAD', 'USD']}
        dateFrom=""
        dateTo=""
        onDateChange={() => {}}
      />
    )
    const select = harness.container.querySelector(
      '[data-slot="native-select"]'
    ) as HTMLSelectElement | null
    expect(select).not.toBeNull()
    await act(async () => {
      setNativeValue(select!, 'USD')
      select!.dispatchEvent(new Event('input', { bubbles: true }))
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onCurrencyChange).toHaveBeenCalledWith('USD')
  })

  it('fires onDateChange with both values when a date input changes', async () => {
    const onDateChange = vi.fn()
    await harness.render(
      <FilterBar
        currency="CAD"
        onCurrencyChange={() => {}}
        availableCurrencies={['CAD']}
        dateFrom=""
        dateTo="2025-05-17"
        onDateChange={onDateChange}
      />
    )
    const dateInputs = harness.container.querySelectorAll(
      'input[type="date"]'
    ) as NodeListOf<HTMLInputElement>
    expect(dateInputs.length).toBe(2)
    // Change the "from" input
    await act(async () => {
      setNativeValue(dateInputs[0], '2025-01-01')
      dateInputs[0].dispatchEvent(new Event('input', { bubbles: true }))
      dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onDateChange).toHaveBeenCalledWith('2025-01-01', '2025-05-17')
  })

  it('fires onDateChange with the range when a quick-range button is clicked', async () => {
    const onDateChange = vi.fn()
    await harness.render(
      <FilterBar
        currency="CAD"
        onCurrencyChange={() => {}}
        availableCurrencies={['CAD']}
        dateFrom=""
        dateTo=""
        onDateChange={onDateChange}
        quickRanges={sampleRanges}
      />
    )
    const buttons = Array.from(
      harness.container.querySelectorAll('button')
    ) as HTMLButtonElement[]
    const ninetyDays = buttons.find((b) => b.textContent === '90 days')
    expect(ninetyDays).not.toBeUndefined()
    await act(async () => {
      dispatchClick(ninetyDays!)
    })
    expect(onDateChange).toHaveBeenCalledWith('2025-02-16', '2025-05-17')
  })

  it('marks the matching quick-range button as aria-pressed', async () => {
    await harness.render(
      <FilterBar
        currency="CAD"
        onCurrencyChange={() => {}}
        availableCurrencies={['CAD']}
        dateFrom="2025-02-16"
        dateTo="2025-05-17"
        onDateChange={() => {}}
        quickRanges={sampleRanges}
      />
    )
    const buttons = Array.from(
      harness.container.querySelectorAll('button')
    ) as HTMLButtonElement[]
    const byLabel = (label: string) =>
      buttons.find((b) => b.textContent === label)
    expect(byLabel('90 days')?.getAttribute('aria-pressed')).toBe('true')
    expect(byLabel('30 days')?.getAttribute('aria-pressed')).toBe('false')
    expect(byLabel('All time')?.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('csv helpers', () => {
  it('passes through plain values without quoting', () => {
    expect(escapeCsvField('hello')).toBe('hello')
    expect(escapeCsvField('CAD')).toBe('CAD')
  })

  it('renders numbers as plain numeric strings (no currency symbol)', () => {
    expect(escapeCsvField(123.45)).toBe('123.45')
    expect(escapeCsvField(0)).toBe('0')
    expect(escapeCsvField(-7.5)).toBe('-7.5')
  })

  it('treats null and undefined as empty cells', () => {
    expect(escapeCsvField(null)).toBe('')
    expect(escapeCsvField(undefined)).toBe('')
  })

  it('quotes fields that contain commas, quotes, or newlines and doubles inner quotes', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""')
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"')
  })

  it('builds a CSV string with a UTF-8 BOM, CRLF separators, and a trailing newline', () => {
    const csv = buildCsv(
      ['Currency', 'Amount'],
      [
        ['CAD', 123.45],
        ['USD', -7.5],
      ]
    )
    // BOM prefix lets Excel detect UTF-8 cleanly.
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv).toBe('﻿Currency,Amount\r\nCAD,123.45\r\nUSD,-7.5\r\n')
  })

  it('escapes embedded commas inside ownership-style names', () => {
    const csv = buildCsv(['Ownership'], [['Smith, John'], ['Solo']])
    expect(csv).toContain('"Smith, John"')
    expect(csv).toContain('Solo')
  })
})
