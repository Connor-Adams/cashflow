/**
 * Per-person loan ledger (issue: per-person-loan-ledger). One-stop view of
 * each contact's raw transfer flow and tracked-loan outstanding. Drill into a
 * contact to see their linked transfers, mark outflows as loans, run the
 * "Link transfers" auto-matcher, and resolve ambiguous matches manually.
 *
 * Landing now shows numbers: net owed per currency, horizontal CSS bar
 * (net-owed portion vs returned portion). Contacts marked isSelf are shown in
 * a muted exclusion section, not in the owed list.
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { UserX } from 'lucide-react'
import { Badge, Icon } from '@connor-adams/designsystem'
import { Button } from '@connor-adams/designsystem'
import { Card } from '@connor-adams/designsystem'
import { EmptyTableRow } from '@/lib/ds-extras'
import { PageHeader } from '@/components/ui/page-header'
import { SkeletonRow } from '@/lib/ds-extras'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@connor-adams/designsystem'
import { useToast } from '@/components/ui/toast'
import type {
  ContactLedgerResponse,
  SelfSuggestion,
  TransferLinkResult,
} from '@cashflow/shared'
import {
  getJson,
  getContactLedger,
  previewTransferLink,
  commitTransferLink,
  markTransactionAsLoan,
  setTransactionContact,
  getSelfSuggestions,
  setContactSelf,
} from '../lib/api'
import { formatNetLabel } from '../lib/peopleLedger'
import { formatMoney } from '../lib/formatMoney'

// ── Local types ──────────────────────────────────────────────────────────────

interface ContactLite {
  id: number
  name: string
  isSelf: boolean
  isPartner: boolean
}

interface ContactWithLedger {
  contact: ContactLite
  ledger: ContactLedgerResponse | null
}

const TRANSFER_COL_COUNT = 5

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Compute the primary CAD (or first-currency) sent/returned bar widths from
 * a ledger's transferNet. Returns { sentPct, netPct } as 0–100 values.
 * Used for the horizontal bar visual on the landing list.
 *
 * "sent" = total out; "returned" = total in; "net" = sent − returned.
 * The bar's full width = sent. net portion (darker) + returned portion (lighter).
 */
function computeBarSegments(ledger: ContactLedgerResponse | null): {
  netPct: number
  returnedPct: number
  currency: string
  sent: number
  net: number
} | null {
  if (!ledger || ledger.transferNet.length === 0) return null
  // prefer CAD, else first entry
  const row =
    ledger.transferNet.find((n) => n.currency === 'CAD') ??
    ledger.transferNet[0]
  const sent = Math.abs(Number(row.sent))
  const returned = Math.abs(Number(row.received))
  const net = Number(row.net)
  if (sent === 0) return null
  const returnedPct = Math.min(100, (returned / sent) * 100)
  const netPct = Math.max(0, 100 - returnedPct)
  return { netPct, returnedPct, currency: row.currency, sent, net }
}

/**
 * Derive top-level metric totals from all loaded ledgers.
 * grossNetOwed = sum of positive-net (owed to us) amounts across all contacts,
 * in the first/primary currency. We keep it simple: CAD sum or first currency.
 */
function deriveMetrics(cwl: ContactWithLedger[]) {
  let grossNetOwedCad = 0
  let trackedLoansCount = 0
  const seen = new Set<number>()
  for (const { contact, ledger } of cwl) {
    if (contact.isSelf || contact.isPartner || !ledger) continue
    const cadRow =
      ledger.transferNet.find((n) => n.currency === 'CAD') ??
      ledger.transferNet[0]
    if (cadRow) {
      const v = Number(cadRow.net)
      if (v > 0) grossNetOwedCad += v
    }
    const loanCount = Object.keys(ledger.trackedOutstandingByCurrency).filter(
      (cur) => Number(ledger.trackedOutstandingByCurrency[cur]) > 0,
    ).length
    if (loanCount > 0 && !seen.has(contact.id)) {
      seen.add(contact.id)
      trackedLoansCount++
    }
  }
  return { grossNetOwedCad, trackedLoansCount }
}

// ── MetricCard ───────────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
}: {
  label: string
  value: string | number
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

// ── NetBar ───────────────────────────────────────────────────────────────────

/** Horizontal stacked bar: net-owed (primary) + returned (lighter). */
function NetBar({ ledger }: { ledger: ContactLedgerResponse | null }) {
  const segs = computeBarSegments(ledger)
  if (!segs) return null
  const { netPct, returnedPct, currency, sent, net } = segs
  return (
    <div className="flex flex-col gap-1">
      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
        aria-label={`Net owed bar: ${currency} ${net.toFixed(2)}`}
      >
        {/* returned portion — lighter accent */}
        <div
          className="absolute right-0 top-0 h-full bg-primary/20"
          style={{ width: `${returnedPct.toFixed(1)}%` }}
        />
        {/* net-owed portion — solid primary */}
        <div
          className="absolute left-0 top-0 h-full bg-primary"
          style={{ width: `${netPct.toFixed(1)}%` }}
        />
      </div>
      <div className="text-xs text-muted-foreground">
        sent {formatMoney(sent, currency)} · {netPct > 0 ? `${netPct.toFixed(0)}% outstanding` : 'fully returned'}
      </div>
    </div>
  )
}

// ── SelfAccountSection ───────────────────────────────────────────────────────

function SelfAccountSection({
  suggestions,
  onExclude,
  excluding,
}: {
  suggestions: SelfSuggestion[]
  onExclude: (id: number) => void
  excluding: Set<number>
}) {
  if (suggestions.length === 0) return null
  return (
    <div className="mb-4" data-testid="self-account-section">
      <div className="mb-2 flex items-center gap-2">
        <UserX className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium text-muted-foreground">
          These look like your own accounts
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {suggestions.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-input bg-muted/30 px-3 py-2"
            data-testid={`self-suggestion-${s.id}`}
          >
            <div>
              <div className="text-sm font-medium">{s.name}</div>
              <div className="text-xs text-muted-foreground" data-testid={`self-reason-${s.id}`}>{s.reason}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={excluding.has(s.id)}
              onClick={() => onExclude(s.id)}
              data-testid={`exclude-btn-${s.id}`}
            >
              {excluding.has(s.id) ? 'Excluding…' : 'Not a person — exclude'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── PeopleLedgerPage ─────────────────────────────────────────────────────────

export function PeopleLedgerPage() {
  const { showToast } = useToast()
  // Stable ref so loadAll doesn't need showToast in its dep array
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  const [params, setParams] = useSearchParams()
  const selectedId = params.get('contact') ? Number(params.get('contact')) : null

  // Landing state
  const [contacts, setContacts] = useState<ContactLite[]>([])
  const [contactsLoading, setContactsLoading] = useState(true)
  const [ledgerMap, setLedgerMap] = useState<Map<number, ContactLedgerResponse>>(new Map())
  const [ledgersLoading, setLedgersLoading] = useState(false)
  const [selfSuggestions, setSelfSuggestions] = useState<SelfSuggestion[]>([])
  const [excluding, setExcluding] = useState<Set<number>>(new Set())

  // Drill-in state
  const [ledger, setLedger] = useState<ContactLedgerResponse | null>(null)
  const [ledgerLoading, setLedgerLoading] = useState(false)
  const [linkResult, setLinkResult] = useState<TransferLinkResult | null>(null)
  const [linking, setLinking] = useState(false)

  // ── Load contacts + per-contact ledgers + self-suggestions ──────────────

  const loadAll = useCallback(async (isActive: () => boolean = () => true) => {
    if (isActive()) setContactsLoading(true)
    try {
      const [rawContacts, suggestionsResp] = await Promise.all([
        getJson<ContactLite[]>('/api/contacts'),
        getSelfSuggestions().catch(() => ({ suggestions: [] as SelfSuggestion[] })),
      ])
      if (isActive()) setContacts(rawContacts)
      if (isActive()) setSelfSuggestions(suggestionsResp.suggestions)

      // Fetch ledgers for all non-self, non-partner contacts in parallel (small N)
      const realContacts = rawContacts.filter((c) => !c.isSelf && !c.isPartner)
      if (realContacts.length > 0) {
        if (isActive()) setLedgersLoading(true)
        const entries = await Promise.all(
          realContacts.map((c) =>
            getContactLedger(c.id)
              .then((l) => [c.id, l] as [number, ContactLedgerResponse])
              .catch(() => null),
          ),
        )
        const m = new Map<number, ContactLedgerResponse>()
        for (const e of entries) {
          if (e) m.set(e[0], e[1])
        }
        if (isActive()) setLedgerMap(m)
        if (isActive()) setLedgersLoading(false)
      }
    } catch (e) {
      if (isActive()) showToastRef.current({
        title: e instanceof Error ? e.message : 'Failed to load contacts',
        variant: 'destructive',
      })
    } finally {
      if (isActive()) setContactsLoading(false)
    }
    // showToastRef is a stable ref — intentionally excluded from dep array
  }, [])

  useEffect(() => {
    let active = true
    void loadAll(() => active)
    return () => { active = false }
  }, [loadAll])

  // ── Load drill-in ledger ──────────────────────────────────────────────────

  useEffect(() => {
    if (selectedId == null) { setLedger(null); return }
    let cancelled = false
    setLedgerLoading(true)
    getContactLedger(selectedId)
      .then((data) => { if (!cancelled) setLedger(data) })
      .catch(() => { if (!cancelled) setLedger(null) })
      .finally(() => { if (!cancelled) setLedgerLoading(false) })
    return () => { cancelled = true }
  }, [selectedId])

  const reload = useCallback(() => {
    if (selectedId == null) return
    setLedgerLoading(true)
    getContactLedger(selectedId)
      .then(setLedger)
      .catch(() => {})
      .finally(() => setLedgerLoading(false))
  }, [selectedId])

  // ── Drill-in actions ──────────────────────────────────────────────────────

  async function onMarkLoan(txnId: number) {
    if (selectedId == null) return
    try {
      await markTransactionAsLoan(txnId, selectedId)
      showToastRef.current({ title: 'Marked as loan', variant: 'success' })
      reload()
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Update failed', variant: 'destructive' })
    }
  }

  async function onPreviewLink() {
    try {
      const r = await previewTransferLink()
      setLinkResult(r)
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Preview failed', variant: 'destructive' })
    }
  }

  async function onCommitLink() {
    setLinking(true)
    try {
      const r = await commitTransferLink()
      setLinkResult(r)
      showToastRef.current({ title: 'Transfers linked', variant: 'success' })
      reload()
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Link failed', variant: 'destructive' })
    } finally {
      setLinking(false)
    }
  }

  async function onResolveAmbiguous(txnId: number, contactId: number) {
    try {
      await setTransactionContact(txnId, contactId)
      const r = await previewTransferLink()
      setLinkResult(r)
      showToastRef.current({ title: 'Contact assigned', variant: 'success' })
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Assign failed', variant: 'destructive' })
    }
  }

  // ── Self-account exclusion ────────────────────────────────────────────────

  async function onExclude(id: number) {
    setExcluding((prev) => new Set([...prev, id]))
    try {
      await setContactSelf(id, true)
      showToastRef.current({ title: 'Contact excluded as self-account', variant: 'success' })
      await loadAll()
    } catch (e) {
      showToastRef.current({ title: e instanceof Error ? e.message : 'Exclude failed', variant: 'destructive' })
    } finally {
      setExcluding((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const ambiguous = linkResult?.ambiguous ?? []

  // Non-self, non-partner contacts sorted by their primary net desc
  const realContacts = contacts.filter((c) => !c.isSelf && !c.isPartner)
  const sortedContacts = [...realContacts].sort((a, b) => {
    const aLedger = ledgerMap.get(a.id)
    const bLedger = ledgerMap.get(b.id)
    const aNet = aLedger
      ? Number(
          (aLedger.transferNet.find((n) => n.currency === 'CAD') ?? aLedger.transferNet[0])?.net ?? 0,
        )
      : 0
    const bNet = bLedger
      ? Number(
          (bLedger.transferNet.find((n) => n.currency === 'CAD') ?? bLedger.transferNet[0])?.net ?? 0,
        )
      : 0
    return bNet - aNet
  })

  const selfContacts = contacts.filter((c) => c.isSelf)

  const cwl: ContactWithLedger[] = sortedContacts.map((c) => ({
    contact: c,
    ledger: ledgerMap.get(c.id) ?? null,
  }))
  const { grossNetOwedCad, trackedLoansCount } = deriveMetrics(cwl)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <PageHeader
        title="People"
        description="Track raw transfer flow and tracked-loan balances with each contact."
      />

      {/* Link-transfers action bar */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        {selectedId != null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setParams({})}
          >
            ← All contacts
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onPreviewLink}
          >
            Preview link
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={linking}
            onClick={onCommitLink}
          >
            {linking ? 'Linking…' : 'Link transfers'}
          </Button>
        </div>
      </div>

      {/* Ambiguous manual-pick queue */}
      {ambiguous.length > 0 && (
        <Card className="mb-4 p-4">
          <div className="mb-2 flex items-center gap-2">
            <Icon name="alert-triangle" className="size-4 text-warning" aria-hidden="true" />
            <span className="text-sm font-medium">Ambiguous matches — pick the right contact</span>
          </div>
          <div className="flex flex-col gap-2">
            {ambiguous.map((a) => (
              <div key={a.txnId} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{a.merchantText}</span>
                {a.contactIds.map((cid) => {
                  const label = contacts.find((c) => c.id === cid)?.name ?? `#${cid}`
                  return (
                    <Button
                      key={cid}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onResolveAmbiguous(a.txnId, cid)}
                    >
                      {label}
                    </Button>
                  )
                })}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Landing: contact list with numbers ── */}
      {selectedId == null && (
        <>
          {/* Metric cards */}
          {!contactsLoading && !ledgersLoading && (
            <Card className="mb-4 p-4" data-testid="metrics-card">
              <div className="flex flex-wrap gap-8">
                <MetricCard
                  label="Gross net owed"
                  value={formatMoney(grossNetOwedCad, 'CAD')}
                />
                <MetricCard
                  label="People"
                  value={realContacts.length}
                />
                <MetricCard
                  label="Tracked loans"
                  value={trackedLoansCount}
                />
                <MetricCard
                  label="Flagged to exclude"
                  value={selfContacts.length + selfSuggestions.length}
                />
              </div>
            </Card>
          )}

          {/* Self-account confirmation section */}
          <SelfAccountSection
            suggestions={selfSuggestions}
            onExclude={onExclude}
            excluding={excluding}
          />

          {/* Contact list */}
          <Card className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Raw net</TableHead>
                  <TableHead>Outstanding loans</TableHead>
                  <TableHead>Flow</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contactsLoading || ledgersLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <SkeletonRow key={`people-skel-${i}`} cols={4} />
                  ))
                ) : sortedContacts.length === 0 ? (
                  <EmptyTableRow
                    colSpan={4}
                    title="No contacts yet."
                    description="Add contacts in Settings to start tracking transfers with them."
                  />
                ) : (
                  sortedContacts.map((c) => {
                    const cl = ledgerMap.get(c.id)
                    return (
                      <TableRow
                        key={c.id}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => setParams({ contact: String(c.id) })}
                        data-testid={`contact-row-${c.id}`}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Icon name="users" className="size-4 text-muted-foreground" aria-hidden="true" />
                            <span>{c.name}</span>
                          </div>
                        </TableCell>
                        <TableCell data-testid={`net-${c.id}`}>
                          {cl && cl.transferNet.length > 0 ? (
                            <div className="flex flex-col gap-0.5">
                              {cl.transferNet.map((n) => (
                                <span key={n.currency} className="text-sm font-medium">
                                  {formatNetLabel(n)}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {cl && Object.keys(cl.trackedOutstandingByCurrency).some(
                            (cur) => Number(cl.trackedOutstandingByCurrency[cur]) > 0,
                          ) ? (
                            <div className="flex flex-col gap-0.5">
                              {Object.entries(cl.trackedOutstandingByCurrency)
                                .filter(([, amt]) => Number(amt) > 0)
                                .map(([cur, amt]) => (
                                  <span key={cur} className="text-sm font-medium">
                                    {formatMoney(Number(amt), cur)}
                                  </span>
                                ))}
                            </div>
                          ) : (
                            <span className="text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="min-w-32">
                          <NetBar ledger={cl ?? null} />
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </Card>

          {/* Excluded / self-account contacts shown muted below */}
          {selfContacts.length > 0 && (
            <div className="mt-4" data-testid="excluded-contacts">
              <div className="mb-2 flex items-center gap-2">
                <UserX className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Excluded — own accounts
                </span>
              </div>
              <div className="flex flex-col gap-1">
                {selfContacts.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 px-1 py-0.5 text-sm text-muted-foreground"
                  >
                    <span>{c.name}</span>
                    <Badge variant="secondary">self-account</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Drill-in: contact ledger detail view ── */}
      {selectedId != null && (
        <>
          {ledgerLoading ? (
            <Card className="mb-4 p-4">
              <div className="text-muted-foreground text-sm">Loading…</div>
            </Card>
          ) : ledger ? (
            <>
              {/* Summary card: two numbers + sent/returned visual */}
              <Card className="mb-4 p-4" data-testid="ledger-summary-card">
                <h2 className="mb-3 text-base font-semibold">{ledger.name}</h2>
                <div className="flex flex-wrap gap-8">
                  <div>
                    <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">Raw net flow</div>
                    {ledger.transferNet.length === 0 ? (
                      <div className="text-sm">—</div>
                    ) : (
                      ledger.transferNet.map((n) => (
                        <div key={n.currency} className="text-lg font-semibold">
                          {formatNetLabel(n)}
                        </div>
                      ))
                    )}
                  </div>
                  <div data-testid="tracked-outstanding">
                    <div className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">Tracked loans outstanding</div>
                    {Object.keys(ledger.trackedOutstandingByCurrency).length === 0 ? (
                      <div className="text-sm">—</div>
                    ) : (
                      Object.entries(ledger.trackedOutstandingByCurrency).map(([cur, amt]) => (
                        <div key={cur} className="text-lg font-semibold">
                          {cur} {Number(amt).toFixed(2)}
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {/* Sent / returned bar for this contact */}
                {ledger.transferNet.length > 0 && (
                  <div className="mt-4 max-w-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                      Sent vs returned
                    </div>
                    <NetBar ledger={ledger} />
                  </div>
                )}
              </Card>

              {/* Transfer table */}
              <Card className="overflow-x-auto p-0">
                <Table data-testid="transfers-table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Merchant</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Direction</TableHead>
                      <TableHead aria-label="actions" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ledger.transfers.length === 0 ? (
                      <EmptyTableRow
                        colSpan={TRANSFER_COL_COUNT}
                        title="No transfers with this contact."
                        description="Import transactions or link a transfer to see them here."
                      />
                    ) : (
                      ledger.transfers.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell>{t.date}</TableCell>
                          <TableCell>{t.merchant}</TableCell>
                          <TableCell>
                            {t.currency} {Number(t.amount).toFixed(2)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={t.direction === 'out' ? 'outline' : 'secondary'}>
                              {t.direction === 'out' ? 'Out' : 'In'}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end">
                              {t.direction === 'out' && !t.isLoan && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => onMarkLoan(t.id)}
                                >
                                  Mark as loan
                                </Button>
                              )}
                              {t.isLoan && (
                                <Badge variant="default">Loan</Badge>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </Card>
            </>
          ) : (
            <Card className="p-4">
              <div className="text-muted-foreground text-sm">Could not load ledger for this contact.</div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}
