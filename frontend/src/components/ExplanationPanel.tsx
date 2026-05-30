/**
 * Structured per-field explanation of why a transaction has its current
 * category, split, business flag, notes, and review state.
 *
 * Issue: #230 (feat: explain transaction categorization decisions).
 *
 * The structured shape comes from GET /api/transactions/:id/explanation
 * which delegates to `backend/src/util/transactionExplanation.ts`. This
 * component renders the explanation in plain English with attribution links
 * (to the applied rule, to the AI suggestion id) and a safe fallback message
 * for missing data.
 */
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import type {
  AppliedRuleAttribution,
  AiSuggestionAttribution,
  CategoryExplanation,
  SplitExplanation,
  BusinessExplanation,
  NotesExplanation,
  ReviewExplanation,
  ManualEditAttribution,
  TransactionExplanation,
} from '../types/api'

const SOURCE_VARIANT: Record<
  string,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  rule: 'default',
  manual: 'secondary',
  ai: 'default',
  'import-default': 'secondary',
  fallback: 'outline',
  none: 'outline',
  cleared: 'default',
  'needs-review': 'destructive',
  'never-flagged': 'secondary',
}

function SourceBadge({ source }: { source: string }) {
  const label = source
    .replace('-', ' ')
    .replace(/^./, (c) => c.toUpperCase())
  return (
    <Badge variant={SOURCE_VARIANT[source] ?? 'secondary'}>{label}</Badge>
  )
}

function RuleLink({ rule }: { rule: AppliedRuleAttribution }) {
  return (
    <div className="muted" style={{ marginTop: '0.2rem', fontSize: '0.85rem' }}>
      Rule:{' '}
      <Link to={`/rules?highlight=${rule.id}`}>
        <code>{rule.merchantPattern}</code>
      </Link>
      {rule.category != null && (
        <>
          {' '}
          → <code>{rule.category}</code>
        </>
      )}
    </div>
  )
}

function AiLink({ ai }: { ai: AiSuggestionAttribution }) {
  return (
    <div className="muted" style={{ marginTop: '0.2rem', fontSize: '0.85rem' }}>
      AI suggestion #{ai.id} ({ai.status}
      {ai.model != null && (
        <>
          {' '}
          · model <code>{ai.model}</code>
        </>
      )}
      {' '}
      · {ai.createdAt.slice(0, 10)})
    </div>
  )
}

function ManualEditNote({ edit }: { edit: ManualEditAttribution }) {
  const who = edit.actorDisplayName ?? 'a household member'
  const when = edit.at.slice(0, 10)
  return (
    <div className="muted" style={{ marginTop: '0.2rem', fontSize: '0.85rem' }}>
      Last edited by {who} on {when}.
    </div>
  )
}

type FieldExplanation =
  | CategoryExplanation
  | SplitExplanation
  | BusinessExplanation

function ExplanationRow({
  label,
  ex,
  renderValue,
}: {
  label: string
  ex: FieldExplanation
  renderValue: (v: FieldExplanation['value']) => React.ReactNode
}) {
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div
        className="row"
        style={{ gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}
      >
        <strong>{label}:</strong>
        <span>{renderValue(ex.value)}</span>
        <SourceBadge source={ex.source} />
      </div>
      <div style={{ marginTop: '0.15rem' }}>{ex.message}</div>
      {ex.appliedRule && <RuleLink rule={ex.appliedRule} />}
      {ex.aiSuggestion && <AiLink ai={ex.aiSuggestion} />}
      {ex.manualEdit && <ManualEditNote edit={ex.manualEdit} />}
      {ex.signalRationale && (
        <div className="muted" style={{ marginTop: '0.2rem', fontSize: '0.85rem' }}>
          <em>{ex.signalRationale}</em>
        </div>
      )}
      {ex.overrideValue != null && ex.autoValue != null && ex.source === 'manual' && (
        <div className="muted" style={{ marginTop: '0.2rem', fontSize: '0.8rem' }}>
          (Auto-suggested:{' '}
          <code>{String(ex.autoValue)}</code>
          {' '}
          · Manual:{' '}
          <code>{String(ex.overrideValue)}</code>)
        </div>
      )}
    </div>
  )
}

function NotesRow({ ex }: { ex: NotesExplanation }) {
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div
        className="row"
        style={{ gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}
      >
        <strong>Notes:</strong>
        <span>{ex.value ?? <em className="muted">none</em>}</span>
        <SourceBadge source={ex.source} />
      </div>
      <div style={{ marginTop: '0.15rem' }}>{ex.message}</div>
      {ex.manualEdit && <ManualEditNote edit={ex.manualEdit} />}
    </div>
  )
}

function ReviewRow({ ex }: { ex: ReviewExplanation }) {
  return (
    <div style={{ marginBottom: '0.25rem' }}>
      <div
        className="row"
        style={{ gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}
      >
        <strong>Review:</strong>
        <SourceBadge source={ex.state} />
      </div>
      <div style={{ marginTop: '0.15rem' }}>{ex.message}</div>
      {ex.lastChangedAt && (
        <div className="muted" style={{ marginTop: '0.2rem', fontSize: '0.85rem' }}>
          State last changed on {ex.lastChangedAt.slice(0, 10)}.
        </div>
      )}
    </div>
  )
}

export function ExplanationPanel({
  explanation,
}: {
  explanation: TransactionExplanation
}) {
  return (
    <section
      aria-label="Categorisation explanation"
      style={{ marginTop: '0.25rem' }}
    >
      <ExplanationRow
        label="Category"
        ex={explanation.category}
        renderValue={(v) =>
          v != null ? <code>{v}</code> : <em className="muted">not set</em>
        }
      />
      <ExplanationRow
        label="Split"
        ex={explanation.split}
        renderValue={(v) => <code>{String(v)}</code>}
      />
      <ExplanationRow
        label="Business"
        ex={explanation.business}
        renderValue={(v) => <code>{String(v)}</code>}
      />
      <NotesRow ex={explanation.notes} />
      <ReviewRow ex={explanation.review} />
    </section>
  )
}
