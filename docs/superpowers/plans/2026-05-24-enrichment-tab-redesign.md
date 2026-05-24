# Enrichment Tab Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 400-LoC `frontend/src/pages/settings/tabs/EnrichmentTab.tsx` with a workflow-fused dashboard that uses the existing Cashflow design system (StatCard, Card, recharts, palette tokens), splits responsibilities across five new presentational components, and deep-links to the existing `/rules` and `/review` pages instead of duplicating CRUD.

**Architecture:** Five new presentational sub-components live under `frontend/src/pages/settings/tabs/enrichment/` and are composed by a slim `EnrichmentTab.tsx` that owns data fetching + backfill state. No backend changes. One ergonomic change to `RulesPage` (handle `?focus=<ruleId>` to scroll + highlight a row).

**Tech Stack:** React 19, TypeScript, Tailwind, Cashflow palette tokens (light + dark in `frontend/src/index.css`), `recharts` (already in deps), Vitest + React Testing Library, react-router-dom v6.

**Spec:** [`docs/superpowers/specs/2026-05-24-enrichment-tab-redesign.md`](../specs/2026-05-24-enrichment-tab-redesign.md)

---

## File structure

```
frontend/src/pages/settings/tabs/
├── EnrichmentTab.tsx                                  (rewrite — composes sections, owns state)
├── EnrichmentTab.test.tsx                              (rewrite — high-level integration)
└── enrichment/                                         (new directory)
    ├── EnrichmentStatRow.tsx                           (new — workflow tile + 5 stats)
    ├── EnrichmentStatRow.test.tsx                      (new)
    ├── EnrichmentConfidenceChart.tsx                   (new — stacked bar + legend)
    ├── EnrichmentConfidenceChart.test.tsx              (new)
    ├── EnrichmentSourceChart.tsx                       (new — horizontal bar chart)
    ├── EnrichmentSourceChart.test.tsx                  (new)
    ├── EnrichmentTopLists.tsx                          (new — two cards: rules + merchants)
    ├── EnrichmentTopLists.test.tsx                     (new)
    ├── EnrichmentBackfillCard.tsx                      (new — extracted backfill UI + streaming)
    └── EnrichmentBackfillCard.test.tsx                 (new — moved from EnrichmentTab.test.tsx)

frontend/src/pages/
├── RulesPage.tsx                                       (modify — read ?focus, scroll + highlight row)
└── RulesPage.test.tsx                                  (extend — focus query param test)

frontend/src/App.css                                    (extend — .ruleRow.isFocused highlight)
```

`EnrichmentTab.tsx` shrinks from ~400 LoC to ~80 LoC of pure composition. Each sub-component stays ≤120 LoC with one clear responsibility.

---

## Conventions used in this plan

- Frontend test runner: `yarn workspace frontend test <path>` — runs vitest against a single file.
- Linter runs in pre-commit via lint-staged (already wired). Don't add `--no-verify`.
- All commits should pass `yarn workspace frontend run lint` and `yarn workspace frontend run test`.
- Cashflow palette tokens live in `frontend/src/index.css`. Use semantic Tailwind utilities (`bg-card`, `text-warning-foreground`, etc.) — never raw hex.
- The `StatCard` primitive at `frontend/src/components/ui/stat-card.tsx` takes `label`, `value`, `hint?`, `delta?`. Use it for every numeric tile.
- The `Card` primitive at `frontend/src/components/ui/card.tsx` is the wrapper for every section card.

---

## Task 1: Add `?focus=<ruleId>` support to RulesPage

Decoupled prerequisite. Lands before any EnrichmentTab code so the deep-link target exists.

**Files:**
- Modify: `frontend/src/pages/RulesPage.tsx`
- Modify: `frontend/src/App.css` (one new class)
- Modify: `frontend/src/pages/RulesPage.test.tsx` (extend; create if missing)

- [ ] **Step 1: Check whether RulesPage.test.tsx exists**

Run: `ls frontend/src/pages/RulesPage.test.tsx 2>/dev/null && echo "exists" || echo "missing"`
Expected: either "exists" or "missing". If missing, create it with the minimal scaffold in Step 2.

- [ ] **Step 2: Write the failing test for focus highlight**

If the test file is missing, create `frontend/src/pages/RulesPage.test.tsx` with this full content. If it exists, append the new `describe('?focus query param', ...)` block after the existing describes.

```typescript
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RulesPage } from './RulesPage'
import { ToastProvider } from '@/components/ui/toast'

const SAMPLE_RULES = [
  { id: 1, merchantPattern: 'amazon', matchKind: 'substring', priority: 0, category: 'Shopping', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, usageCount: 1204 },
  { id: 2, merchantPattern: 'uber', matchKind: 'substring', priority: 0, category: 'Transport', isBusiness: false, splitType: 'me', pctMe: null, pctPartner: null, usageCount: 312 },
]

function mockFetch(rules: typeof SAMPLE_RULES) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo) => {
    const url = String(input)
    if (url.endsWith('/api/rules')) return Promise.resolve({ ok: true, json: () => Promise.resolve(rules) } as Response)
    if (url.endsWith('/api/ai/rule-proposals')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ proposals: [] }) } as Response)
    if (url.endsWith('/api/transactions/category-hints')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories: [] }) } as Response)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
  }))
}

describe('RulesPage', () => {
  beforeEach(() => {
    mockFetch(SAMPLE_RULES)
    Element.prototype.scrollIntoView = vi.fn()
  })

  describe('?focus query param', () => {
    it('applies isFocused class to the row whose id matches focus', async () => {
      render(
        <MemoryRouter initialEntries={['/rules?focus=2']}>
          <ToastProvider>
            <RulesPage />
          </ToastProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('uber')).toBeInTheDocument())
      const row = screen.getByText('uber').closest('tr')!
      expect(row.className).toContain('isFocused')
    })

    it('calls scrollIntoView on the focused row', async () => {
      render(
        <MemoryRouter initialEntries={['/rules?focus=2']}>
          <ToastProvider>
            <RulesPage />
          </ToastProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('uber')).toBeInTheDocument())
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    })

    it('does not error when focus is missing', async () => {
      render(
        <MemoryRouter initialEntries={['/rules']}>
          <ToastProvider>
            <RulesPage />
          </ToastProvider>
        </MemoryRouter>,
      )
      await waitFor(() => expect(screen.getByText('amazon')).toBeInTheDocument())
      const row = screen.getByText('amazon').closest('tr')!
      expect(row.className).not.toContain('isFocused')
    })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `yarn workspace frontend test src/pages/RulesPage.test.tsx`
Expected: FAIL with "isFocused" not found or scrollIntoView not called.

- [ ] **Step 4: Add focus logic to RulesPage.tsx**

Modify `frontend/src/pages/RulesPage.tsx`:

a) Update the import line at the top:

```typescript
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
```

b) Inside `RulesPage()`, after the existing `const [rules, setRules] = useState<Rule[]>([])` block, add:

```typescript
const [searchParams] = useSearchParams()
const focusedId = (() => {
  const raw = searchParams.get('focus')
  if (raw == null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
})()
const focusedRowRef = useRef<HTMLTableRowElement | null>(null)

useEffect(() => {
  if (focusedId == null) return
  if (rules.length === 0) return
  focusedRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}, [focusedId, rules.length])
```

c) Find the existing rule rendering line (the `<tr key={r.id}>` near line 311) and replace it with:

```typescript
                rules.map((r) => (
                  <tr
                    key={r.id}
                    ref={r.id === focusedId ? focusedRowRef : undefined}
                    className={r.id === focusedId ? 'ruleRow isFocused' : 'ruleRow'}
                  >
```

- [ ] **Step 5: Add highlight CSS**

Append to `frontend/src/App.css` (end of file):

```css
.ruleRow.isFocused td {
  animation: ruleFocusFlash 2s ease-out 1;
  background-color: color-mix(in srgb, var(--primary) 14%, transparent);
}

@keyframes ruleFocusFlash {
  0%   { background-color: color-mix(in srgb, var(--primary) 32%, transparent); }
  100% { background-color: color-mix(in srgb, var(--primary) 14%, transparent); }
}
```

- [ ] **Step 6: Run tests**

Run: `yarn workspace frontend test src/pages/RulesPage.test.tsx`
Expected: PASS — all three focus tests green.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/RulesPage.tsx frontend/src/pages/RulesPage.test.tsx frontend/src/App.css
git commit -m "feat(rules): support ?focus=<ruleId> for deep-link scroll + highlight

Adds query-param-driven row focusing so other pages can link to a
specific rule. Behavior is unchanged when ?focus is absent."
```

---

## Task 2: Create EnrichmentBackfillCard (extracted from EnrichmentTab)

Pulls the existing backfill form + streaming progress feed into its own component with no behavioral change. The test moves with it.

**Files:**
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentBackfillCard.tsx`
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentBackfillCard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentBackfillCard.test.tsx`:

```typescript
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { EnrichmentBackfillCard } from './EnrichmentBackfillCard'
import { ToastProvider } from '@/components/ui/toast'

describe('EnrichmentBackfillCard', () => {
  it('renders title, description, and admin pill', () => {
    render(
      <ToastProvider>
        <EnrichmentBackfillCard onComplete={() => undefined} />
      </ToastProvider>,
    )
    expect(screen.getByRole('heading', { name: /backfill enrichment/i })).toBeInTheDocument()
    expect(screen.getByText(/admin action/i)).toBeInTheDocument()
    expect(screen.getByText(/re-runs the import enrichment pipeline/i)).toBeInTheDocument()
  })

  it('exposes Dry run and Run backfill buttons', () => {
    render(
      <ToastProvider>
        <EnrichmentBackfillCard onComplete={() => undefined} />
      </ToastProvider>,
    )
    expect(screen.getByRole('button', { name: /dry run/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run backfill/i })).toBeInTheDocument()
  })

  it('exposes both toggle checkboxes and the row-limit input', () => {
    render(
      <ToastProvider>
        <EnrichmentBackfillCard onComplete={() => undefined} />
      </ToastProvider>,
    )
    expect(screen.getByLabelText(/clear review flag/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/only re-process rows currently in review/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/all rows/i)).toBeInTheDocument()
  })

  it('toggling review-only mode flips the checkbox state', () => {
    render(
      <ToastProvider>
        <EnrichmentBackfillCard onComplete={() => undefined} />
      </ToastProvider>,
    )
    const cb = screen.getByLabelText(/only re-process rows currently in review/i) as HTMLInputElement
    expect(cb.checked).toBe(false)
    fireEvent.click(cb)
    expect(cb.checked).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentBackfillCard.test.tsx`
Expected: FAIL with "Cannot find module './EnrichmentBackfillCard'".

- [ ] **Step 3: Create the component**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentBackfillCard.tsx`. Move the backfill logic verbatim from the current `EnrichmentTab.tsx` (lines 17–142 for state + `runBackfill`, lines 146–273 for rendering). Wrap in `<Card>` and apply token-only styling. Replace inline `style={...}` with utility classes or new class names — no raw hex.

```typescript
import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useConfirm } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { EnrichmentBackfillProgress } from '../../../../types/api'

type BackfillSummary = Extract<EnrichmentBackfillProgress, { kind: 'summary' }>
type BackfillProgressRow = Extract<EnrichmentBackfillProgress, { kind: 'progress' }>
type BackfillErrorEvent = Extract<EnrichmentBackfillProgress, { kind: 'error' }>

const MAX_FEED_ROWS = 200

type Props = {
  /** Called when a real (non-dry) backfill finishes successfully so the parent can refresh stats. */
  onComplete: () => void
}

export function EnrichmentBackfillCard({ onComplete }: Props) {
  const [backfillRunning, setBackfillRunning] = useState<'dry' | 'real' | null>(null)
  const [backfillSummary, setBackfillSummary] = useState<BackfillSummary | null>(null)
  const [backfillError, setBackfillError] = useState<string | null>(null)
  const [backfillFeed, setBackfillFeed] = useState<BackfillProgressRow[]>([])
  const [backfillErrors, setBackfillErrors] = useState<BackfillErrorEvent[]>([])
  const [backfillLive, setBackfillLive] = useState<{ processed: number; cleared: number; skipped: number } | null>(null)
  const [backfillClearReview, setBackfillClearReview] = useState(true)
  const [backfillReviewOnly, setBackfillReviewOnly] = useState(false)
  const [backfillLimit, setBackfillLimit] = useState('')

  const confirm = useConfirm()

  async function runBackfill(mode: 'dry' | 'real') {
    if (backfillRunning) return
    if (mode === 'real') {
      const ok = await confirm({
        title: 'Run enrichment backfill?',
        description:
          'Re-runs the import enrichment pipeline against every transaction in your household. Override fields and already-reviewed rows are untouched.',
        confirmLabel: 'Run backfill',
      })
      if (!ok) return
    }
    setBackfillRunning(mode)
    setBackfillError(null)
    setBackfillSummary(null)
    setBackfillFeed([])
    setBackfillErrors([])
    setBackfillLive({ processed: 0, cleared: 0, skipped: 0 })

    const limit = Number(backfillLimit.trim())
    const body: Record<string, unknown> = {
      dryRun: mode === 'dry',
      noReviewFlag: !backfillClearReview,
      reviewOnly: backfillReviewOnly,
    }
    if (Number.isFinite(limit) && limit > 0) body.limit = Math.floor(limit)

    try {
      const base = import.meta.env.VITE_API_BASE ?? ''
      const res = await fetch(`${base}/api/transactions/enrichment/backfill?stream=1`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => res.statusText)
        throw new Error(text || `HTTP ${res.status}`)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let processed = 0
      let cleared = 0
      let skipped = 0
      let liveFeed: BackfillProgressRow[] = []
      let liveErrors: BackfillErrorEvent[] = []
      let lastFlush = Date.now()
      const flush = () => {
        setBackfillFeed(liveFeed.slice())
        setBackfillErrors(liveErrors.slice())
        setBackfillLive({ processed, cleared, skipped })
        lastFlush = Date.now()
      }
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (!line) continue
          let event: EnrichmentBackfillProgress
          try {
            event = JSON.parse(line) as EnrichmentBackfillProgress
          } catch {
            continue
          }
          if (event.kind === 'progress') {
            processed++
            if (event.reviewFlagCleared) cleared++
            liveFeed = [event, ...liveFeed].slice(0, MAX_FEED_ROWS)
          } else if (event.kind === 'error') {
            skipped++
            liveErrors = [event, ...liveErrors].slice(0, 50)
          } else if (event.kind === 'summary') {
            setBackfillSummary(event)
          }
          if (Date.now() - lastFlush > 100) flush()
        }
      }
      flush()
      if (mode === 'real') onComplete()
    } catch (e) {
      setBackfillError(e instanceof Error ? e.message : 'Backfill failed')
    } finally {
      setBackfillRunning(null)
    }
  }

  return (
    <Card className="enrichBackfillCard">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div>
          <h2 className="text-base font-semibold m-0">Backfill enrichment</h2>
          <p className="muted text-sm mt-1 mb-0">
            Re-runs the import enrichment pipeline against every transaction in your household. Override fields and
            already-reviewed rows are never touched.
          </p>
        </div>
        <span className="enrichAdminPill">Admin action</span>
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={backfillClearReview}
            onChange={(e) => setBackfillClearReview(e.target.checked)}
            disabled={backfillRunning != null}
          />
          Clear review flag on rows the pipeline can now confidently categorise
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={backfillReviewOnly}
            onChange={(e) => setBackfillReviewOnly(e.target.checked)}
            disabled={backfillRunning != null}
          />
          Only re-process rows currently in review
        </label>
        <Label htmlFor="settings-backfill-limit" className="text-sm m-0">
          <span className="sr-only">Row limit</span>
          <Input
            id="settings-backfill-limit"
            type="number"
            min={1}
            placeholder="all rows"
            value={backfillLimit}
            onChange={(e) => setBackfillLimit(e.target.value)}
            disabled={backfillRunning != null}
            className="w-32"
          />
        </Label>
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={backfillRunning != null}
            onClick={() => void runBackfill('dry')}
          >
            <Sparkles aria-hidden="true" />
            {backfillRunning === 'dry' ? 'Running dry run…' : 'Dry run'}
          </Button>
          <Button
            type="button"
            disabled={backfillRunning != null}
            onClick={() => void runBackfill('real')}
          >
            <Sparkles aria-hidden="true" />
            {backfillRunning === 'real' ? 'Running backfill…' : 'Run backfill'}
          </Button>
        </div>
      </div>
      {backfillError && (
        <span className="error mt-2 block" role="alert">
          {backfillError}
        </span>
      )}
      {(backfillRunning || backfillLive || backfillSummary) && (
        <div className="mt-3">
          {backfillSummary ? (
            <p>
              <strong>
                {backfillSummary.dryRun ? 'Dry run — no changes written.' : 'Backfill complete.'}
              </strong>{' '}
              Processed {backfillSummary.processed}, updated {backfillSummary.updated}, review flag cleared on{' '}
              {backfillSummary.reviewFlagCleared}, signals written {backfillSummary.signalsWritten}, skipped{' '}
              {backfillSummary.skipped} ({(backfillSummary.durationMs / 1000).toFixed(1)}s).
            </p>
          ) : backfillLive ? (
            <p className="muted">
              Streaming… processed {backfillLive.processed}, cleared {backfillLive.cleared}, skipped{' '}
              {backfillLive.skipped}
            </p>
          ) : null}
          {backfillErrors.length > 0 && (
            <details className="mt-1">
              <summary className="error">{backfillErrors.length} row(s) failed</summary>
              <ul className="text-xs mt-1">
                {backfillErrors.slice(0, 20).map((e, i) => (
                  <li key={i}>txn {e.txnId ?? '?'}: {e.message}</li>
                ))}
              </ul>
            </details>
          )}
          {backfillFeed.length > 0 && (
            <div className="enrichBackfillFeed" role="log" aria-live="polite">
              {backfillFeed.map((row) => (
                <div key={row.txnId} className="enrichBackfillFeed__row">
                  <span className="muted enrichBackfillFeed__id">#{row.txnId}</span>
                  <span className="enrichBackfillFeed__raw">{row.merchantRaw}</span>
                  <span>
                    → <strong>{row.merchantCanonical ?? row.merchantClean}</strong>
                  </span>
                  <span className="muted enrichBackfillFeed__src">
                    {row.autoSource ?? '—'}/{row.autoConfidence ?? '—'}
                  </span>
                  {row.reviewFlagCleared && <span className="enrichBackfillFeed__cleared">✓ cleared</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
```

- [ ] **Step 4: Add supporting CSS classes**

Append to `frontend/src/App.css`:

```css
.enrichAdminPill {
  background: color-mix(in srgb, var(--accent) 100%, transparent);
  color: var(--accent-foreground);
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.enrichBackfillFeed {
  margin-top: 0.5rem;
  max-height: 18rem;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  padding-top: 0.5rem;
  font-size: 0.78rem;
  line-height: 1.3;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.enrichBackfillFeed__row {
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}

.enrichBackfillFeed__id {
  width: 4rem;
  text-align: right;
}

.enrichBackfillFeed__raw {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.enrichBackfillFeed__src {
  min-width: 6rem;
}

.enrichBackfillFeed__cleared {
  color: var(--success);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentBackfillCard.test.tsx`
Expected: PASS — all four tests green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/enrichment/EnrichmentBackfillCard.tsx frontend/src/pages/settings/tabs/enrichment/EnrichmentBackfillCard.test.tsx frontend/src/App.css
git commit -m "feat(settings): extract EnrichmentBackfillCard component

Pulls backfill form + streaming progress feed out of EnrichmentTab.tsx
into a dedicated component. Inline styles replaced with token-driven
CSS classes. Behavior is preserved verbatim; wiring into EnrichmentTab
follows in a later task."
```

---

## Task 3: Create EnrichmentStatRow (workflow tile + 5 stat tiles)

**Files:**
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentStatRow.tsx`
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentStatRow.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentStatRow.test.tsx`:

```typescript
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { EnrichmentStatRow } from './EnrichmentStatRow'
import type { EnrichmentStats } from '../../../../types/api'

const STATS: EnrichmentStats = {
  total: 15247,
  reviewFlagTrue: 2341,
  reviewFlagFalse: 12906,
  reviewedTrue: 8000,
  bySource: { rules: 10368, ai: 3354, manual: 1220, '(none)': 305 },
  byConfidence: { high: 9148, medium: 3812, low: 1525, '(none)': 762 },
  byTxnType: {},
  isRecurringCount: 847,
  refundLinkedCount: 98,
  transferLinkedCount: 312,
  topCanonicalMerchants: [],
  topRules: [],
}

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>
}

describe('EnrichmentStatRow', () => {
  it('renders the warning-tinted Needs review tile when reviewFlagTrue > 0', () => {
    render(wrap(<EnrichmentStatRow stats={STATS} />))
    expect(screen.getByText(/needs review/i)).toBeInTheDocument()
    expect(screen.getByText('2,341')).toBeInTheDocument()
  })

  it('shows a CTA linking to /review when reviewFlagTrue > 0', () => {
    render(wrap(<EnrichmentStatRow stats={STATS} />))
    const cta = screen.getByRole('link', { name: /open review queue/i })
    expect(cta).toHaveAttribute('href', '/review')
  })

  it('shows the low-confidence percentage in the subtitle', () => {
    render(wrap(<EnrichmentStatRow stats={STATS} />))
    // 1525 low / 2341 review = 65% (rounded)
    expect(screen.getByText(/65% low-confidence/i)).toBeInTheDocument()
  })

  it('renders 5 dashboard stat tiles with formatted counts', () => {
    render(wrap(<EnrichmentStatRow stats={STATS} />))
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('15,247')).toBeInTheDocument()
    expect(screen.getByText('Cleared')).toBeInTheDocument()
    expect(screen.getByText('12,906')).toBeInTheDocument()
    expect(screen.getByText('Recurring')).toBeInTheDocument()
    expect(screen.getByText('847')).toBeInTheDocument()
    expect(screen.getByText('Refunds linked')).toBeInTheDocument()
    expect(screen.getByText('98')).toBeInTheDocument()
    expect(screen.getByText('Transfers linked')).toBeInTheDocument()
    expect(screen.getByText('312')).toBeInTheDocument()
  })

  it('renders an "In review: 0" tile (no CTA) when the backlog is empty', () => {
    render(wrap(<EnrichmentStatRow stats={{ ...STATS, reviewFlagTrue: 0 }} />))
    expect(screen.getByText(/in review/i)).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /open review queue/i })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentStatRow.test.tsx`
Expected: FAIL with "Cannot find module './EnrichmentStatRow'".

- [ ] **Step 3: Create the component**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentStatRow.tsx`:

```typescript
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import { StatCard } from '@/components/ui/stat-card'
import type { EnrichmentStats } from '../../../../types/api'

type Props = {
  stats: EnrichmentStats
}

export function EnrichmentStatRow({ stats }: Props) {
  const totalPct = stats.total > 0 ? Math.round((stats.reviewFlagTrue / stats.total) * 100) : 0
  const lowConfRows = stats.byConfidence['low'] ?? 0
  const lowConfPct = stats.reviewFlagTrue > 0
    ? Math.round((lowConfRows / stats.reviewFlagTrue) * 100)
    : 0

  const cleared = stats.reviewFlagFalse.toLocaleString()
  const total = stats.total.toLocaleString()

  return (
    <div className="enrichStatGrid">
      {stats.reviewFlagTrue > 0 ? (
        <Card className="enrichWorkflowTile">
          <p className="statLabel enrichWorkflowTile__label">Needs review</p>
          <p className="statValue enrichWorkflowTile__value">
            {stats.reviewFlagTrue.toLocaleString()}{' '}
            <span className="enrichWorkflowTile__pct">{totalPct}%</span>
          </p>
          <p className="enrichWorkflowTile__sub">{lowConfPct}% low-confidence</p>
          <Link to="/review" className="enrichWorkflowTile__cta">
            Open review queue →
          </Link>
        </Card>
      ) : (
        <StatCard className="enrichWorkflowTile enrichWorkflowTile--empty" label="In review" value="0" />
      )}
      <StatCard label="Total" value={total} />
      <StatCard label="Cleared" value={cleared} className="enrichStatCleared" />
      <StatCard label="Recurring" value={stats.isRecurringCount.toLocaleString()} />
      <StatCard label="Refunds linked" value={stats.refundLinkedCount.toLocaleString()} />
      <StatCard label="Transfers linked" value={stats.transferLinkedCount.toLocaleString()} />
    </div>
  )
}
```

- [ ] **Step 4: Add CSS for the grid + workflow tile**

Append to `frontend/src/App.css`:

```css
.enrichStatGrid {
  display: grid;
  grid-template-columns: 1.6fr repeat(5, 1fr);
  gap: 0.625rem;
  margin-bottom: 0.875rem;
}

@media (max-width: 960px) {
  .enrichStatGrid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 520px) {
  .enrichStatGrid { grid-template-columns: 1fr; }
}

.enrichWorkflowTile {
  background: var(--warning-bg);
  border-color: color-mix(in srgb, var(--warning) 40%, var(--border));
  color: var(--warning-foreground);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 0.5rem;
}

.enrichWorkflowTile--empty {
  background: var(--card);
  border-color: var(--border);
  color: var(--foreground);
}

.enrichWorkflowTile__label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--warning-foreground);
  opacity: 0.85;
  margin: 0;
}

.enrichWorkflowTile__value {
  font-size: 1.7rem;
  font-weight: 700;
  line-height: 1.1;
  color: var(--warning-foreground);
  margin: 0.125rem 0 0;
  font-variant-numeric: tabular-nums;
}

.enrichWorkflowTile__pct {
  font-size: 0.8rem;
  font-weight: 500;
  opacity: 0.75;
}

.enrichWorkflowTile__sub {
  font-size: 0.78rem;
  color: var(--warning-foreground);
  opacity: 0.85;
  margin: 0.25rem 0 0;
}

.enrichWorkflowTile__cta {
  display: inline-block;
  padding: 7px 14px;
  font-size: 0.8rem;
  font-weight: 600;
  border-radius: 6px;
  background: var(--primary);
  color: var(--primary-foreground);
  border: 1px solid var(--primary-hover);
  text-decoration: none;
  align-self: flex-start;
  margin-top: auto;
}

.enrichWorkflowTile__cta:hover {
  background: var(--primary-hover);
}

.enrichStatCleared .statValue {
  color: var(--success);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentStatRow.test.tsx`
Expected: PASS — all five tests green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/enrichment/EnrichmentStatRow.tsx frontend/src/pages/settings/tabs/enrichment/EnrichmentStatRow.test.tsx frontend/src/App.css
git commit -m "feat(settings): add EnrichmentStatRow with fused workflow tile

Renders the 6-tile stat grid: warning-tinted Needs Review tile with
CTA into /review when the backlog is non-empty, plus five StatCards
for the rest. Uses palette tokens only (warning-bg, warning-foreground,
primary, success)."
```

---

## Task 4: Create EnrichmentConfidenceChart

**Files:**
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentConfidenceChart.tsx`
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentConfidenceChart.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentConfidenceChart.test.tsx`:

```typescript
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { EnrichmentConfidenceChart } from './EnrichmentConfidenceChart'

describe('EnrichmentConfidenceChart', () => {
  it('renders the heading and the total row pill', () => {
    render(
      <EnrichmentConfidenceChart byConfidence={{ high: 9148, medium: 3812, low: 1525, '(none)': 762 }} />,
    )
    expect(screen.getByText(/confidence distribution/i)).toBeInTheDocument()
    // 9148 + 3812 + 1525 + 762 = 15247
    expect(screen.getByText('15,247 rows')).toBeInTheDocument()
  })

  it('renders all four bands with formatted counts', () => {
    render(
      <EnrichmentConfidenceChart byConfidence={{ high: 9148, medium: 3812, low: 1525, '(none)': 762 }} />,
    )
    expect(screen.getByText(/High/)).toBeInTheDocument()
    expect(screen.getByText('9,148')).toBeInTheDocument()
    expect(screen.getByText(/Med/)).toBeInTheDocument()
    expect(screen.getByText('3,812')).toBeInTheDocument()
    expect(screen.getByText(/Low/)).toBeInTheDocument()
    expect(screen.getByText('1,525')).toBeInTheDocument()
    expect(screen.getByText(/None/)).toBeInTheDocument()
    expect(screen.getByText('762')).toBeInTheDocument()
  })

  it('treats a missing band as 0', () => {
    render(<EnrichmentConfidenceChart byConfidence={{ high: 100 }} />)
    expect(screen.getByText(/High/)).toBeInTheDocument()
    expect(screen.getByText('100')).toBeInTheDocument()
    expect(screen.getByText(/Med/)).toBeInTheDocument()
    // Three zeros: med, low, none
    expect(screen.getAllByText('0')).toHaveLength(3)
  })

  it('renders an empty-row pill when there are no rows', () => {
    render(<EnrichmentConfidenceChart byConfidence={{}} />)
    expect(screen.getByText('0 rows')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentConfidenceChart.test.tsx`
Expected: FAIL with module not found.

- [ ] **Step 3: Create the component**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentConfidenceChart.tsx`:

```typescript
import { Card } from '@/components/ui/card'

type Band = {
  key: 'high' | 'medium' | 'low' | '(none)'
  label: string
  cssVar: string
}

const BANDS: Band[] = [
  { key: 'high',   label: 'High', cssVar: 'var(--success)' },
  { key: 'medium', label: 'Med',  cssVar: 'var(--primary)' },
  { key: 'low',    label: 'Low',  cssVar: 'var(--warning)' },
  { key: '(none)', label: 'None', cssVar: 'var(--muted-foreground)' },
]

type Props = {
  byConfidence: Record<string, number>
}

export function EnrichmentConfidenceChart({ byConfidence }: Props) {
  const counts = BANDS.map((b) => ({ ...b, n: byConfidence[b.key] ?? 0 }))
  const total = counts.reduce((acc, c) => acc + c.n, 0)

  return (
    <Card className="enrichChartCard">
      <div className="enrichChartCard__header">
        <h3 className="enrichChartCard__title">Confidence distribution</h3>
        <span className="enrichAdminPill enrichAdminPill--amber">{total.toLocaleString()} rows</span>
      </div>
      <div className="enrichConfidenceBar" role="img" aria-label={`Confidence distribution: ${counts.map((c) => `${c.label} ${c.n}`).join(', ')}`}>
        {counts.map((c) => (
          <div
            key={c.key}
            className="enrichConfidenceBar__seg"
            style={{ flex: c.n > 0 ? c.n : 0, background: c.cssVar }}
            title={`${c.label}: ${c.n.toLocaleString()}`}
          />
        ))}
      </div>
      <div className="enrichConfidenceLegend">
        {counts.map((c) => (
          <span key={c.key} className="enrichConfidenceLegend__item">
            <span className="enrichConfidenceLegend__swatch" style={{ background: c.cssVar }} />
            <span className="enrichConfidenceLegend__label">{c.label}</span>{' '}
            <span className="enrichConfidenceLegend__count">{c.n.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </Card>
  )
}
```

- [ ] **Step 4: Add CSS for the chart card**

Append to `frontend/src/App.css`:

```css
.enrichChartCard__header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.75rem;
}

.enrichChartCard__title {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0;
}

.enrichAdminPill--amber {
  background: color-mix(in srgb, var(--primary) 24%, transparent);
  color: var(--primary-foreground);
}

.enrichConfidenceBar {
  display: flex;
  height: 22px;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 0.625rem;
  background: var(--muted);
}

.enrichConfidenceBar__seg {
  height: 100%;
  min-width: 0;
}

.enrichConfidenceLegend {
  display: flex;
  gap: 0.875rem;
  flex-wrap: wrap;
  font-size: 0.74rem;
  color: var(--muted-foreground);
}

.enrichConfidenceLegend__item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
}

.enrichConfidenceLegend__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.enrichConfidenceLegend__label {
  color: var(--foreground);
  font-weight: 500;
}

.enrichConfidenceLegend__count {
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentConfidenceChart.test.tsx`
Expected: PASS — all four tests green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/enrichment/EnrichmentConfidenceChart.tsx frontend/src/pages/settings/tabs/enrichment/EnrichmentConfidenceChart.test.tsx frontend/src/App.css
git commit -m "feat(settings): add EnrichmentConfidenceChart

Stacked horizontal bar visualising high/med/low/none confidence
buckets, with token-coloured swatches and a tabular-nums legend.
Handles missing keys and zero totals."
```

---

## Task 5: Create EnrichmentSourceChart

**Files:**
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentSourceChart.tsx`
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentSourceChart.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentSourceChart.test.tsx`:

```typescript
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { EnrichmentSourceChart } from './EnrichmentSourceChart'

describe('EnrichmentSourceChart', () => {
  it('renders the heading and per-source rows', () => {
    render(
      <EnrichmentSourceChart bySource={{ rules: 10368, ai: 3354, manual: 1220, '(none)': 305 }} />,
    )
    expect(screen.getByText(/by source/i)).toBeInTheDocument()
    expect(screen.getByText('rules')).toBeInTheDocument()
    expect(screen.getByText('ai')).toBeInTheDocument()
    expect(screen.getByText('manual')).toBeInTheDocument()
    expect(screen.getByText('none')).toBeInTheDocument()
  })

  it('sorts rows by count descending', () => {
    const { container } = render(
      <EnrichmentSourceChart bySource={{ rules: 10368, ai: 3354, manual: 1220, '(none)': 305 }} />,
    )
    const labels = Array.from(container.querySelectorAll('.enrichSourceBar__label')).map(
      (el) => el.textContent,
    )
    expect(labels).toEqual(['rules', 'ai', 'manual', 'none'])
  })

  it('renders percentages rounded to whole numbers', () => {
    render(<EnrichmentSourceChart bySource={{ rules: 68, ai: 22, manual: 8, '(none)': 2 }} />)
    expect(screen.getByText(/68 · 68%/)).toBeInTheDocument()
    expect(screen.getByText(/22 · 22%/)).toBeInTheDocument()
    expect(screen.getByText(/8 · 8%/)).toBeInTheDocument()
    expect(screen.getByText(/2 · 2%/)).toBeInTheDocument()
  })

  it('renders an empty-state message when bySource is empty', () => {
    render(<EnrichmentSourceChart bySource={{}} />)
    expect(screen.getByText(/no source data yet/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentSourceChart.test.tsx`
Expected: FAIL with module not found.

- [ ] **Step 3: Create the component**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentSourceChart.tsx`:

```typescript
import { Card } from '@/components/ui/card'

const SOURCE_COLOR: Record<string, string> = {
  rules: 'var(--chart-2)',
  ai: 'var(--chart-3)',
  manual: 'var(--chart-5)',
  '(none)': 'var(--border)',
}

const LABEL: Record<string, string> = {
  '(none)': 'none',
}

type Props = {
  bySource: Record<string, number>
}

export function EnrichmentSourceChart({ bySource }: Props) {
  const entries = Object.entries(bySource).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((acc, [, n]) => acc + n, 0)

  return (
    <Card className="enrichChartCard">
      <div className="enrichChartCard__header">
        <h3 className="enrichChartCard__title">By source</h3>
      </div>
      {entries.length === 0 ? (
        <p className="muted text-sm m-0">No source data yet. Run the backfill to populate.</p>
      ) : (
        <div className="enrichSourceList">
          {entries.map(([key, n]) => {
            const pct = total > 0 ? Math.round((n / total) * 100) : 0
            const color = SOURCE_COLOR[key] ?? 'var(--muted-foreground)'
            const label = LABEL[key] ?? key
            return (
              <div key={key} className="enrichSourceBar">
                <span className="enrichSourceBar__label">{label}</span>
                <div className="enrichSourceBar__track">
                  <div
                    className="enrichSourceBar__fill"
                    style={{ width: `${pct}%`, background: color }}
                  />
                </div>
                <span className="enrichSourceBar__count">{n.toLocaleString()} · {pct}%</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
```

- [ ] **Step 4: Add CSS for the source list**

Append to `frontend/src/App.css`:

```css
.enrichSourceList {
  display: grid;
  gap: 0.5rem;
  font-size: 0.78rem;
}

.enrichSourceBar {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}

.enrichSourceBar__label {
  width: 3.5rem;
  text-align: right;
  color: var(--muted-foreground);
}

.enrichSourceBar__track {
  flex: 1;
  background: var(--muted);
  height: 14px;
  border-radius: 3px;
  overflow: hidden;
}

.enrichSourceBar__fill {
  height: 100%;
  border-radius: 3px;
}

.enrichSourceBar__count {
  width: 6rem;
  color: var(--foreground);
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentSourceChart.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/enrichment/EnrichmentSourceChart.tsx frontend/src/pages/settings/tabs/enrichment/EnrichmentSourceChart.test.tsx frontend/src/App.css
git commit -m "feat(settings): add EnrichmentSourceChart

Horizontal-bar breakdown of rules/ai/manual/(none) enrichment sources
with count + rounded percent labels. Sorted desc by count. Empty
state when bySource is empty."
```

---

## Task 6: Create EnrichmentTopLists

Renders two cards side-by-side: top firing rules (with View deep-link to /rules?focus) and top canonical merchants (read-only). Deep-links to merchants are deliberately not included — see spec.

**Files:**
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentTopLists.tsx`
- Create: `frontend/src/pages/settings/tabs/enrichment/EnrichmentTopLists.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentTopLists.test.tsx`:

```typescript
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { EnrichmentTopLists } from './EnrichmentTopLists'
import type { EnrichmentStats } from '../../../../types/api'

const TOP_RULES: EnrichmentStats['topRules'] = [
  { ruleId: 11, pattern: 'amazon', category: 'Shopping', count: 1204 },
  { ruleId: 7, pattern: 'uber', category: 'Transport', count: 312 },
  { ruleId: 19, pattern: 'spotify', category: null, count: 89 },
]

const TOP_MERCHANTS: EnrichmentStats['topCanonicalMerchants'] = [
  { name: 'Amazon', count: 1247 },
  { name: 'Uber', count: 312 },
]

function wrap(ui: React.ReactNode) {
  return <MemoryRouter>{ui}</MemoryRouter>
}

describe('EnrichmentTopLists', () => {
  it('renders both cards with their headings', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    expect(screen.getByText(/top firing rules/i)).toBeInTheDocument()
    expect(screen.getByText(/top canonical merchants/i)).toBeInTheDocument()
  })

  it('renders View links on rule rows that deep-link to /rules?focus=<ruleId>', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    const amazonView = screen.getByRole('link', { name: /view rule for amazon/i })
    expect(amazonView).toHaveAttribute('href', '/rules?focus=11')
    const uberView = screen.getByRole('link', { name: /view rule for uber/i })
    expect(uberView).toHaveAttribute('href', '/rules?focus=7')
  })

  it('renders a "Manage rules" link in the rules card header', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    const manage = screen.getByRole('link', { name: /manage rules/i })
    expect(manage).toHaveAttribute('href', '/rules')
  })

  it('displays "(no category)" when category is null', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    expect(screen.getByText(/spotify/i)).toBeInTheDocument()
    expect(screen.getByText(/\(no category\)/i)).toBeInTheDocument()
  })

  it('renders merchants as read-only rows (no View link, no anchor)', () => {
    render(wrap(<EnrichmentTopLists topRules={TOP_RULES} topMerchants={TOP_MERCHANTS} />))
    expect(screen.getByText('Amazon')).toBeInTheDocument()
    expect(screen.getByText('1,247')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /view amazon/i })).toBeNull()
  })

  it('shows empty-state copy when both lists are empty', () => {
    render(wrap(<EnrichmentTopLists topRules={[]} topMerchants={[]} />))
    expect(screen.getByText(/no rule matches recorded yet/i)).toBeInTheDocument()
    expect(screen.getByText(/none yet\. run the backfill/i)).toBeInTheDocument()
  })

  it('limits each list to 6 rows', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ruleId: i + 1,
      pattern: `pattern${i}`,
      category: 'Cat',
      count: 100 - i,
    }))
    const manyMerchants = Array.from({ length: 10 }, (_, i) => ({
      name: `Merchant ${i}`,
      count: 100 - i,
    }))
    render(wrap(<EnrichmentTopLists topRules={many} topMerchants={manyMerchants} />))
    expect(screen.getByText('pattern0')).toBeInTheDocument()
    expect(screen.getByText('pattern5')).toBeInTheDocument()
    expect(screen.queryByText('pattern6')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentTopLists.test.tsx`
Expected: FAIL with module not found.

- [ ] **Step 3: Create the component**

Create `frontend/src/pages/settings/tabs/enrichment/EnrichmentTopLists.tsx`:

```typescript
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import type { EnrichmentStats } from '../../../../types/api'

const MAX_ROWS = 6

type Props = {
  topRules: EnrichmentStats['topRules']
  topMerchants: EnrichmentStats['topCanonicalMerchants']
}

export function EnrichmentTopLists({ topRules, topMerchants }: Props) {
  const rules = topRules.slice(0, MAX_ROWS)
  const merchants = topMerchants.slice(0, MAX_ROWS)

  return (
    <div className="enrichListsGrid">
      <Card className="enrichListCard">
        <div className="enrichListCard__header">
          <h3 className="enrichListCard__title">Top firing rules</h3>
          <Link to="/rules" className="enrichListCard__manage">Manage rules →</Link>
        </div>
        {rules.length === 0 ? (
          <p className="muted text-sm m-0">No rule matches recorded yet.</p>
        ) : (
          <div className="enrichListCard__rows">
            {rules.map((r) => (
              <div key={r.ruleId} className="enrichListRow">
                <span className="enrichListRow__primary">
                  <code className="enrichInlineCode">{r.pattern}</code>{' '}
                  → {r.category ?? '(no category)'}
                </span>
                <span className="enrichListRow__count">{r.count.toLocaleString()}</span>
                <Link
                  to={`/rules?focus=${r.ruleId}`}
                  className="enrichListRow__action"
                  aria-label={`View rule for ${r.pattern}`}
                >
                  View
                </Link>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="enrichListCard">
        <div className="enrichListCard__header">
          <h3 className="enrichListCard__title">Top canonical merchants</h3>
        </div>
        {merchants.length === 0 ? (
          <p className="muted text-sm m-0">None yet. Run the backfill to populate.</p>
        ) : (
          <div className="enrichListCard__rows">
            {merchants.map((m) => (
              <div key={m.name} className="enrichListRow enrichListRow--twoCol">
                <span className="enrichListRow__primary">{m.name}</span>
                <span className="enrichListRow__count">{m.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
```

- [ ] **Step 4: Add CSS for the lists**

Append to `frontend/src/App.css`:

```css
.enrichListsGrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.625rem;
  margin-bottom: 0.875rem;
}

@media (max-width: 760px) {
  .enrichListsGrid { grid-template-columns: 1fr; }
}

.enrichListCard__header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.625rem;
}

.enrichListCard__title {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0;
}

.enrichListCard__manage {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--primary);
  text-decoration: none;
}

.enrichListCard__manage:hover {
  text-decoration: underline;
}

.enrichListCard__rows {
  font-size: 0.82rem;
}

.enrichListRow {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 0.625rem;
  padding: 0.5rem 0;
  align-items: baseline;
  border-bottom: 1px solid var(--border);
}

.enrichListRow:last-child { border-bottom: 0; }

.enrichListRow--twoCol { grid-template-columns: 1fr auto; }

.enrichListRow__primary { color: var(--foreground); min-width: 0; }

.enrichListRow__count {
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.enrichListRow__action {
  font-size: 0.75rem;
  color: var(--primary);
  text-decoration: none;
}

.enrichListRow__action:hover { text-decoration: underline; }

.enrichInlineCode {
  background: color-mix(in srgb, var(--primary) 18%, transparent);
  color: var(--primary-foreground);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 0.78rem;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn workspace frontend test src/pages/settings/tabs/enrichment/EnrichmentTopLists.test.tsx`
Expected: PASS — all seven tests green.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/settings/tabs/enrichment/EnrichmentTopLists.tsx frontend/src/pages/settings/tabs/enrichment/EnrichmentTopLists.test.tsx frontend/src/App.css
git commit -m "feat(settings): add EnrichmentTopLists with rule deep-links

Two side-by-side cards. Top firing rules each link to /rules?focus=<id>
(handled by Task 1). Top canonical merchants are read-only until a
merchant filter ships on /transactions in a follow-up PR."
```

---

## Task 7: Rewrite EnrichmentTab to compose the new sections

**Files:**
- Modify: `frontend/src/pages/settings/tabs/EnrichmentTab.tsx` (rewrite)
- Modify: `frontend/src/pages/settings/tabs/EnrichmentTab.test.tsx` (rewrite)

- [ ] **Step 1: Rewrite the integration test**

Replace `frontend/src/pages/settings/tabs/EnrichmentTab.test.tsx` entirely:

```typescript
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EnrichmentTab } from './EnrichmentTab'
import { ToastProvider } from '@/components/ui/toast'

const STATS = {
  total: 15247,
  reviewFlagTrue: 2341,
  reviewFlagFalse: 12906,
  reviewedTrue: 8000,
  bySource: { rules: 10368, ai: 3354, manual: 1220, '(none)': 305 },
  byConfidence: { high: 9148, medium: 3812, low: 1525, '(none)': 762 },
  byTxnType: {},
  isRecurringCount: 847,
  refundLinkedCount: 98,
  transferLinkedCount: 312,
  topCanonicalMerchants: [
    { name: 'Amazon', count: 1247 },
    { name: 'Uber', count: 312 },
  ],
  topRules: [
    { ruleId: 11, pattern: 'amazon', category: 'Shopping', count: 1204 },
    { ruleId: 7, pattern: 'uber', category: 'Transport', count: 312 },
  ],
}

function mockFetch(stats: typeof STATS) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo) => {
      const url = String(input)
      if (url.endsWith('/api/transactions/enrichment/stats'))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(stats) } as Response)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response)
    }),
  )
}

function setup() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <EnrichmentTab />
      </ToastProvider>
    </MemoryRouter>,
  )
}

describe('EnrichmentTab', () => {
  beforeEach(() => mockFetch(STATS))

  it('fetches stats and renders the Needs Review workflow tile', async () => {
    setup()
    await waitFor(() => expect(screen.getByText('2,341')).toBeInTheDocument())
    expect(screen.getByText(/needs review/i)).toBeInTheDocument()
    const cta = screen.getByRole('link', { name: /open review queue/i })
    expect(cta).toHaveAttribute('href', '/review')
  })

  it('renders the dashboard stat row alongside the workflow tile', async () => {
    setup()
    await waitFor(() => expect(screen.getByText('15,247')).toBeInTheDocument())
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('Cleared')).toBeInTheDocument()
    expect(screen.getByText('12,906')).toBeInTheDocument()
  })

  it('renders both chart cards', async () => {
    setup()
    await waitFor(() => expect(screen.getByText(/confidence distribution/i)).toBeInTheDocument())
    expect(screen.getByText(/by source/i)).toBeInTheDocument()
  })

  it('renders the top rules card with View links', async () => {
    setup()
    await waitFor(() => expect(screen.getByText(/top firing rules/i)).toBeInTheDocument())
    const view = screen.getByRole('link', { name: /view rule for amazon/i })
    expect(view).toHaveAttribute('href', '/rules?focus=11')
  })

  it('renders the backfill admin card at the bottom', async () => {
    setup()
    await waitFor(() => expect(screen.getByRole('heading', { name: /backfill enrichment/i })).toBeInTheDocument())
    expect(screen.getByText(/admin action/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /run backfill/i })).toBeInTheDocument()
  })

  it('does not render the old "Enrichment maintenance" or "Enrichment dashboard" headings', async () => {
    setup()
    await waitFor(() => expect(screen.getByText('2,341')).toBeInTheDocument())
    expect(screen.queryByRole('heading', { name: /enrichment maintenance/i })).toBeNull()
    expect(screen.queryByRole('heading', { name: /enrichment dashboard/i })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn workspace frontend test src/pages/settings/tabs/EnrichmentTab.test.tsx`
Expected: FAIL — existing component still renders the old structure with "Enrichment maintenance" / "Enrichment dashboard" headings, and chart cards do not exist yet from this tab's perspective.

- [ ] **Step 3: Rewrite EnrichmentTab.tsx**

Replace `frontend/src/pages/settings/tabs/EnrichmentTab.tsx` entirely:

```typescript
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { getJson } from '../../../lib/api'
import type { EnrichmentStats } from '../../../types/api'
import { EnrichmentStatRow } from './enrichment/EnrichmentStatRow'
import { EnrichmentConfidenceChart } from './enrichment/EnrichmentConfidenceChart'
import { EnrichmentSourceChart } from './enrichment/EnrichmentSourceChart'
import { EnrichmentTopLists } from './enrichment/EnrichmentTopLists'
import { EnrichmentBackfillCard } from './enrichment/EnrichmentBackfillCard'

export function EnrichmentTab() {
  const [stats, setStats] = useState<EnrichmentStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [statsLoading, setStatsLoading] = useState(false)

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      setStats(await getJson<EnrichmentStats>('/api/transactions/enrichment/stats'))
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : 'Could not load stats')
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  return (
    <div className="enrichTabRoot">
      {statsError && (
        <p className="error" role="alert">{statsError}</p>
      )}

      {stats ? (
        <>
          <EnrichmentStatRow stats={stats} />
          <div className="enrichChartsGrid">
            <EnrichmentConfidenceChart byConfidence={stats.byConfidence} />
            <EnrichmentSourceChart bySource={stats.bySource} />
          </div>
          <EnrichmentTopLists topRules={stats.topRules} topMerchants={stats.topCanonicalMerchants} />
        </>
      ) : statsLoading ? (
        <p className="muted">Loading enrichment stats…</p>
      ) : null}

      <div className="enrichRefreshRow">
        <Button type="button" variant="outline" size="sm" disabled={statsLoading} onClick={() => void loadStats()}>
          Refresh stats
        </Button>
      </div>

      <EnrichmentBackfillCard onComplete={() => void loadStats()} />
    </div>
  )
}
```

- [ ] **Step 4: Add the layout CSS**

Append to `frontend/src/App.css`:

```css
.enrichTabRoot {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

.enrichChartsGrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.625rem;
}

@media (max-width: 760px) {
  .enrichChartsGrid { grid-template-columns: 1fr; }
}

.enrichRefreshRow {
  display: flex;
  justify-content: flex-end;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn workspace frontend test src/pages/settings/tabs/EnrichmentTab.test.tsx`
Expected: PASS — all six tests green.

- [ ] **Step 6: Run the full settings test slice**

Run: `yarn workspace frontend test src/pages/settings`
Expected: PASS — including `settings-routing.integration.test.tsx`, which exercises navigation into `/settings/enrichment`.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/settings/tabs/EnrichmentTab.tsx frontend/src/pages/settings/tabs/EnrichmentTab.test.tsx frontend/src/App.css
git commit -m "feat(settings): rewrite EnrichmentTab as fused dashboard+workflow

Replaces the 400-LoC tab with a 60-LoC composition of five new
sub-components. No backend changes. Drops the 'By type' breakdown and
the inline streaming-log noise; backfill UI lives in its own card at
the bottom. All inline styles gone in favour of palette tokens."
```

---

## Task 8: Full app sweep + manual verification

Catch anything the unit tests missed: routing, lint, dark mode reads, narrow-viewport behavior.

**Files:** none modified unless issues found.

- [ ] **Step 1: Run the full frontend test suite**

Run: `yarn workspace frontend test`
Expected: PASS — no regressions outside the changed files.

- [ ] **Step 2: Run the linter**

Run: `yarn workspace frontend run lint`
Expected: PASS — no new warnings introduced by the new files.

- [ ] **Step 3: Type-check**

Run: `yarn workspace frontend run typecheck` (if defined) — otherwise the lint pass plus vitest already covers it. If a typecheck script is missing in `frontend/package.json`, skip this step.

- [ ] **Step 4: Manual smoke — light mode**

Run the dev server: `yarn workspace frontend run dev`

Navigate to `/settings/enrichment` and confirm:
- Workflow tile renders rust-tinted in light mode with readable text
- 5 dashboard stat tiles fill the rest of row 1
- Confidence stacked bar fills row 2 left card; source horizontal bars fill row 2 right card
- Top firing rules card (row 3 left) shows up to 6 rows with `View` links
- Top canonical merchants card (row 3 right) shows read-only rows
- Backfill card at bottom with "Admin action" pill
- Click "Open review queue →" navigates to `/review`
- Click "Manage rules →" navigates to `/rules`
- Click `View` next to a rule navigates to `/rules?focus=<id>`, scrolls to the row, briefly flashes the row background

- [ ] **Step 5: Manual smoke — dark mode**

Toggle dark mode (theme switcher in app shell). Re-walk the same checklist:
- All text remains legible against `ink`/`graphite` backgrounds
- Workflow tile uses `rust-800` background with `rust-100` text
- Bars use `amber-300` / `jade-300` / `plum-300` / `rust-300` (lighter dark-mode tokens) — confirm none are washed out

- [ ] **Step 6: Manual smoke — empty review backlog**

Temporarily edit the mocked stats (or seed an account with `reviewFlag=false` everywhere) and confirm the workflow tile collapses to a plain "In review: 0" StatCard with no CTA. The 6-column row layout stays intact.

- [ ] **Step 7: Manual smoke — narrow viewport**

Resize the browser to ~700px wide. Confirm:
- Stat grid collapses to 2 columns
- Chart grid stacks vertically
- Top-lists grid stacks vertically
- Backfill card controls wrap onto multiple rows without clipping

- [ ] **Step 8: Backfill end-to-end (dry run)**

Click `Dry run`. Confirm:
- Button disables, shows "Running dry run…"
- Streaming feed populates rows below the controls
- On completion, summary line replaces the streaming text
- After dry-run completes, the stats above do **not** refresh (dry run does not change DB state, no `onComplete` triggered)

- [ ] **Step 9: Backfill end-to-end (real run)**

Click `Run backfill`. Confirm:
- Confirm dialog appears with the existing copy
- On confirm: same streaming UI as dry run
- On completion, stats above refresh (the `onComplete` callback calls `loadStats()`)

- [ ] **Step 10: Commit any incidental fixes**

If steps 1–9 surfaced bugs, fix them in focused commits. If nothing changed, skip this step.

```bash
# example only — only run if fixes were made
git add <files>
git commit -m "fix(settings): <specific issue found during manual sweep>"
```

---

## Self-review checklist (done after Task 8)

- [ ] Every spec section ("Section 1 — Stat row" through "Section 4 — Backfill") maps to a task above
- [ ] No `style={{...}}` blocks in any new file (grep: `git diff main -- frontend/src/pages/settings/tabs/enrichment/ | grep 'style={'` should return nothing)
- [ ] No raw hex colors in `App.css` or `.tsx` files added in this PR (grep: `git diff main -- frontend/ | grep -E '#[0-9A-Fa-f]{3,6}'` should be empty or only show pre-existing context lines)
- [ ] `EnrichmentTab.tsx` is ≤ 100 LoC after the rewrite
- [ ] Each new component file is ≤ 200 LoC including imports
- [ ] All seven test files run green individually and together
- [ ] Light mode + dark mode both visually verified
