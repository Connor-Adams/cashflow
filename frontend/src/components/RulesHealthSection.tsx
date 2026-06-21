import { useEffect, useState } from 'react'
import { Alert } from '@connor-adams/designsystem'
import { Badge } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { Grid } from '@/lib/ds-extras'
import { SectionHeader } from '@/components/ui/section-header'
import { StatCard } from '@connor-adams/designsystem'
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { getJson, postJson } from '../lib/api'

/** Shape returned by GET /api/rules/health. Kept inline so the component
 *  stays self-contained; the backend route is the source of truth. */
export type RulesHealth = {
  windowDays: number
  totalRules: number
  totalTransactions: number
  hitCount: number
  hitRate: number
  uncategorizedCount: number
  reviewFlagCount: number
  staleRules: Array<{
    id: number
    merchantPattern: string
    matchKind: string
    category: string | null
    priority: number
    createdAt: string
    lastMatchedAt: string | null
    matchCount: number
  }>
  duplicateRules: Array<{
    merchantPattern: string
    matchKind: string
    ruleIds: number[]
  }>
  topMerchantsWithoutRules: Array<{
    merchantCanonical: string
    count: number
  }>
}

export type RuleSuggestion = {
  merchantPattern: string
  category: string | null
  isBusiness: boolean
  splitType: string
  pctMe: string | null
  pctPartner: string | null
  supportCount: number
  exampleTransactionIds: number[]
}

type Props = {
  /** Called after a suggestion is converted into a real rule so the parent
   *  page can reload its rule list. Also fired after a stale rule is
   *  removed in case we add that later. */
  onAfterCreate: () => void
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return `${Math.round(value * 100)}%`
}

function formatDate(iso: string | null): string {
  if (iso == null) return 'Never'
  // backend gives YYYY-MM-DD for lastMatchedAt; just render as-is.
  return iso
}

export function RulesHealthSection({ onAfterCreate }: Props) {
  const [health, setHealth] = useState<RulesHealth | null>(null)
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [creatingPattern, setCreatingPattern] = useState<string | null>(null)

  async function load() {
    setErr(null)
    try {
      const [healthRes, suggestionsRes] = await Promise.all([
        getJson<RulesHealth>('/api/rules/health'),
        getJson<{ suggestions: RuleSuggestion[] }>('/api/rules/suggestions'),
      ])
      setHealth(healthRes)
      setSuggestions(suggestionsRes.suggestions)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load rule health')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function createFromSuggestion(suggestion: RuleSuggestion) {
    setErr(null)
    setCreatingPattern(suggestion.merchantPattern)
    try {
      await postJson(
        `/api/ai/rule-proposals/${encodeURIComponent(suggestion.merchantPattern)}/approve`,
        suggestion,
      )
      // Refresh local state (drops the just-approved suggestion) and let the
      // parent reload its rule list / proposals so they stay in sync.
      await load()
      onAfterCreate()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create rule')
    } finally {
      setCreatingPattern(null)
    }
  }

  if (err) {
    return (
      <Card className="mb-4">
        <SectionHeader title="Rules health" description="Coverage and gaps for your rule set." />
        <Alert variant="error">{err}</Alert>
      </Card>
    )
  }

  if (!health) {
    return (
      <Card className="mb-4">
        <SectionHeader title="Rules health" description="Loading…" />
      </Card>
    )
  }

  return (
    <Card className="mb-4">
      <SectionHeader
        title="Rules health"
        description={`Coverage and gaps over the last ${health.windowDays} days.`}
        actions={
          <Badge variant="count">
            {health.totalRules} rules
          </Badge>
        }
      />

      {/* Stat grid: standardised to Grid/StatCard for consistent layout across sweep pages */}
      <Grid minItemWidth={160} gap="md" className="mb-4">
        <StatCard
          label="Hit rate"
          value={formatPercent(health.hitRate)}
          hint={`${health.hitCount} of ${health.totalTransactions} txns`}
        />
        <StatCard
          label="Uncategorized"
          value={String(health.uncategorizedCount)}
          hint="No final category"
        />
        <StatCard
          label="Review-flagged"
          value={String(health.reviewFlagCount)}
          hint="Needs your attention"
        />
        <StatCard
          label="Rules"
          value={String(health.totalRules)}
          hint={`${health.staleRules.length} stale, ${health.duplicateRules.length} duplicate`}
        />
      </Grid>

      {suggestions.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold mb-1">Suggested rules</h3>
          <p className="text-xs text-muted-foreground mb-2">
            Repeated reviewed merchants we can automate.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pattern</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Support</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {suggestions.map((s) => (
                <TableRow key={`${s.merchantPattern}-${s.category}-${s.splitType}`}>
                  <TableCell>{s.merchantPattern}</TableCell>
                  <TableCell>{s.category ?? '—'}</TableCell>
                  <TableCell>{s.supportCount} txns</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={creatingPattern === s.merchantPattern}
                      onClick={() => void createFromSuggestion(s)}
                    >
                      {creatingPattern === s.merchantPattern
                        ? 'Creating…'
                        : 'Create rule'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {health.staleRules.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold mb-1">Stale rules</h3>
          <p className="text-xs text-muted-foreground mb-2">
            No match in the last {health.windowDays} days.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pattern</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Last matched</TableHead>
                <TableHead>Total matches</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.staleRules.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.merchantPattern}</TableCell>
                  <TableCell>{r.category ?? '—'}</TableCell>
                  <TableCell>{formatDate(r.lastMatchedAt)}</TableCell>
                  <TableCell>{r.matchCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {health.duplicateRules.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold mb-1">Duplicate rules</h3>
          <p className="text-xs text-muted-foreground mb-2">
            Same pattern and match kind. Higher-priority rule wins; consider
            consolidating.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pattern</TableHead>
                <TableHead>Match</TableHead>
                <TableHead>Rule IDs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.duplicateRules.map((d) => (
                <TableRow key={`${d.merchantPattern}-${d.matchKind}`}>
                  <TableCell>{d.merchantPattern}</TableCell>
                  <TableCell>{d.matchKind}</TableCell>
                  <TableCell>{d.ruleIds.map((id) => `#${id}`).join(', ')}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {health.topMerchantsWithoutRules.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold mb-1">
            Top merchants without rules
          </h3>
          <p className="text-xs text-muted-foreground mb-2">
            Recent merchants that match no existing rule.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Merchant</TableHead>
                <TableHead>Transactions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {health.topMerchantsWithoutRules.map((t) => (
                <TableRow key={t.merchantCanonical}>
                  <TableCell>{t.merchantCanonical}</TableCell>
                  <TableCell>{t.count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  )
}
