import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { ChatProposal, ChatProposalKind, ChatProposalStatus } from '@cashflow/shared'

type Props = {
  proposal: ChatProposal
  onApply: (id: number) => void | Promise<void>
  onReject: (id: number) => void | Promise<void>
  busy?: boolean
  /** Inline error to render at the card foot (e.g. "count_drifted"). */
  error?: string | null
}

/**
 * Proposal preview card. The backend stages every mutation as a
 * `ChatProposal` row; the UI renders one card per pending proposal with
 * Apply / Reject actions. Once status flips out of `pending`, the action
 * buttons disappear and the badge moves to the front.
 *
 * Switches on `proposal.kind` to pick a body renderer. The preview shape
 * is `Record<string, unknown>` on the wire (server-built JSON), so every
 * field access narrows defensively.
 */
export function ChatProposalCard({ proposal, onApply, onReject, busy, error }: Props) {
  const isPending = proposal.status === 'pending'
  return (
    <div
      data-slot="chat-proposal"
      data-kind={proposal.kind}
      data-status={proposal.status}
      className="rounded-lg border border-border bg-card p-3 text-sm shadow-sm"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <strong className="text-sm">{kindLabel(proposal.kind)}</strong>
          <StatusBadge status={proposal.status} />
        </div>
      </div>
      <ProposalBody proposal={proposal} />
      {error ? (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      ) : null}
      {isPending ? (
        <div className="mt-3 flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void onApply(proposal.id)}
          >
            Apply
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => void onReject(proposal.id)}
          >
            Reject
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function ProposalBody({ proposal }: { proposal: ChatProposal }) {
  switch (proposal.kind) {
    case 'bulk_patch':
      return <BulkPatchBody preview={proposal.preview} />
    case 'rule_create':
      return <RuleCreateBody preview={proposal.preview} />
    case 'rule_update':
      return <RuleUpdateBody preview={proposal.preview} />
    case 'rule_delete':
      return <RuleDeleteBody preview={proposal.preview} />
    case 'transaction_edit':
      return <TransactionEditBody preview={proposal.preview} />
    default:
      return <GenericBody preview={proposal.preview} />
  }
}

type Preview = Record<string, unknown>

function BulkPatchBody({ preview }: { preview: Preview }) {
  const matchedCount = numberOrNull(preview.matched_count) ?? numberOrNull(preview.matchedCount)
  const filterSummary = stringOrNull(preview.filter_summary) ?? stringOrNull(preview.filterSummary)
  const sample = Array.isArray(preview.sample) ? (preview.sample as Preview[]) : []
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="space-y-2">
      <div>
        <span className="muted">matches: </span>
        <strong>{matchedCount ?? '?'}</strong>
      </div>
      {filterSummary ? (
        <div className="muted truncate text-xs">{filterSummary}</div>
      ) : null}
      {sample.length > 0 ? (
        <div>
          <button
            type="button"
            className="text-xs underline underline-offset-2"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Hide' : `Show ${sample.length} sample rows`}
          </button>
          {expanded ? (
            <ul className="mt-2 space-y-1 text-xs">
              {sample.slice(0, 10).map((row, idx) => (
                <li key={idx}>
                  <BulkPatchSampleRow row={row} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function BulkPatchSampleRow({ row }: { row: Preview }) {
  const date = stringOrNull(row.date)
  const merchant = stringOrNull(row.merchantClean) ?? stringOrNull(row.merchant_clean) ?? stringOrNull(row.merchant)
  const before = row.before as Preview | null | undefined
  const after = row.after as Preview | null | undefined
  return (
    <div className="rounded border border-border/60 bg-muted/10 px-2 py-1">
      <div className="font-mono text-[11px]">
        {date ? <span className="muted mr-2">{date}</span> : null}
        {merchant ? <span>{merchant}</span> : null}
      </div>
      {before || after ? (
        <div className="muted mt-0.5 text-[11px]">
          {before ? <span>{previewLine(before)}</span> : null}
          {before && after ? <span> → </span> : null}
          {after ? <span>{previewLine(after)}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function RuleCreateBody({ preview }: { preview: Preview }) {
  const rule = (preview.rule_preview ?? preview.rulePreview ?? preview.rule ?? preview) as Preview
  const wouldAffect =
    numberOrNull(preview.would_affect_existing_count) ??
    numberOrNull(preview.wouldAffectExistingCount)
  return (
    <div className="space-y-2">
      <RuleFields rule={rule} />
      {wouldAffect != null ? (
        <div className="muted text-xs">
          would affect <strong>{wouldAffect}</strong> existing transactions
        </div>
      ) : null}
    </div>
  )
}

function RuleUpdateBody({ preview }: { preview: Preview }) {
  const before = (preview.before ?? {}) as Preview
  const after = (preview.after ?? {}) as Preview
  const wouldAffect =
    numberOrNull(preview.would_affect_existing_count) ??
    numberOrNull(preview.wouldAffectExistingCount)
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border border-border/60 bg-muted/10 p-2">
          <div className="muted mb-1 font-semibold uppercase tracking-wide">Before</div>
          <RuleFields rule={before} />
        </div>
        <div className="rounded border border-border/60 bg-muted/10 p-2">
          <div className="muted mb-1 font-semibold uppercase tracking-wide">After</div>
          <RuleFields rule={after} />
        </div>
      </div>
      {wouldAffect != null ? (
        <div className="muted text-xs">
          would affect <strong>{wouldAffect}</strong> existing transactions
        </div>
      ) : null}
    </div>
  )
}

function RuleDeleteBody({ preview }: { preview: Preview }) {
  const summary =
    (preview.rule_summary ?? preview.ruleSummary ?? preview.rule ?? preview) as Preview
  return (
    <div className="space-y-1">
      <div className="muted text-xs">Will delete this rule:</div>
      <RuleFields rule={summary} />
    </div>
  )
}

function TransactionEditBody({ preview }: { preview: Preview }) {
  const before = (preview.before ?? {}) as Preview
  const after = (preview.after ?? {}) as Preview
  const date = stringOrNull(preview.date) ?? stringOrNull(before.date)
  const merchant =
    stringOrNull(preview.merchantClean) ??
    stringOrNull(preview.merchant_clean) ??
    stringOrNull(before.merchantClean) ??
    stringOrNull(before.merchant_clean)
  return (
    <div className="space-y-1">
      <div className="font-mono text-xs">
        {date ? <span className="muted mr-2">{date}</span> : null}
        {merchant ? <span>{merchant}</span> : null}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border border-border/60 bg-muted/10 p-2">
          <div className="muted mb-1 font-semibold uppercase tracking-wide">Before</div>
          <KeyValueList obj={before} />
        </div>
        <div className="rounded border border-border/60 bg-muted/10 p-2">
          <div className="muted mb-1 font-semibold uppercase tracking-wide">After</div>
          <KeyValueList obj={after} />
        </div>
      </div>
    </div>
  )
}

function GenericBody({ preview }: { preview: Preview }) {
  return (
    <pre className="overflow-x-auto rounded bg-muted/30 p-2 text-[11px]">
      {JSON.stringify(preview, null, 2)}
    </pre>
  )
}

function RuleFields({ rule }: { rule: Preview }) {
  const fields: Array<[label: string, value: unknown]> = [
    ['Pattern', rule.merchantPattern ?? rule.merchant_pattern ?? rule.pattern],
    ['Match', rule.matchKind ?? rule.match_kind],
    ['Category', rule.category],
    ['Split', rule.splitType ?? rule.split_type],
    ['% me', rule.pctMe ?? rule.pct_me],
    ['% partner', rule.pctPartner ?? rule.pct_partner],
    ['Business', rule.isBusiness ?? rule.is_business],
    ['Effective from', rule.effectiveFrom ?? rule.effective_from],
    ['Effective to', rule.effectiveTo ?? rule.effective_to],
  ]
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5 text-xs">
      {fields
        .filter(([, v]) => v != null && v !== '')
        .map(([label, v]) => (
          <FieldRow key={label} label={label} value={v} />
        ))}
    </dl>
  )
}

function FieldRow({ label, value }: { label: string; value: unknown }) {
  return (
    <>
      <dt className="muted">{label}</dt>
      <dd className="font-mono break-words">{formatValue(value)}</dd>
    </>
  )
}

function KeyValueList({ obj }: { obj: Preview }) {
  const entries = Object.entries(obj).filter(([, v]) => v != null)
  if (entries.length === 0) return <div className="muted">—</div>
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-2 gap-y-0.5">
      {entries.map(([k, v]) => (
        <FieldRow key={k} label={k} value={v} />
      ))}
    </dl>
  )
}

function StatusBadge({ status }: { status: ChatProposalStatus }) {
  const variant: 'default' | 'secondary' | 'destructive' | 'outline' =
    status === 'applied'
      ? 'default'
      : status === 'rejected' || status === 'expired'
      ? 'destructive'
      : 'outline'
  return <Badge variant={variant}>{status}</Badge>
}

function kindLabel(kind: ChatProposalKind): string {
  switch (kind) {
    case 'bulk_patch':
      return 'Bulk patch'
    case 'rule_create':
      return 'Create rule'
    case 'rule_update':
      return 'Update rule'
    case 'rule_delete':
      return 'Delete rule'
    case 'transaction_edit':
      return 'Edit transaction'
    default:
      return kind
  }
}

function previewLine(obj: Preview): string {
  return Object.entries(obj)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(', ')
}

function formatValue(v: unknown): string {
  if (v == null) return '—'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number' || typeof v === 'string') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
