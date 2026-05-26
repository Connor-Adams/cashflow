/**
 * Tax Hygiene tab — surfaces the business-tax review queue, missing receipts,
 * and a deductible / HST-GST estimate for the selected scope. Renders inside
 * /tax; lifted into TaxPage's tab list so it benefits from the year picker
 * the rest of the tax surface already drives (the hygiene endpoints honour
 * a from/to range — TaxPage's `year` becomes Jan 1 → Dec 31).
 *
 * Scope selector defaults to `business` because that's the dashboard's
 * primary intent (a Canadian sole-prop or incorporated user reviewing
 * deductibles ahead of T2125/T2 filing). Personal / shared / all are also
 * supported per AC #7 ("separate personal/shared/business views").
 */
import { useMemo, useState } from 'react';
import {
  TAX_SCOPE_LABELS,
  patchTransactionTax,
  useMissingReceipts,
  useReviewQueue,
  useTaxSummary,
  useTaxTags,
  type TaxScope,
} from '../../hooks/useTaxHygiene';
import { fmtCurrency, fmtPct } from './util/format';

interface Props {
  year: number;
}

const SCOPES: TaxScope[] = ['business', 'personal', 'shared', 'all'];

export function TaxHygieneTab({ year }: Props) {
  const [scope, setScope] = useState<TaxScope>('business');
  const filters = useMemo(
    () => ({
      scope,
      from: `${year}-01-01`,
      to: `${year}-12-31`,
    }),
    [scope, year],
  );

  const summary = useTaxSummary(filters);
  const missing = useMissingReceipts(filters);
  const review = useReviewQueue(filters);
  const { tags } = useTaxTags();

  const handleScopeChange = (s: TaxScope) => setScope(s);

  const handleExport = () => {
    const qs = new URLSearchParams({
      scope,
      from: filters.from,
      to: filters.to,
    });
    // The export endpoint sets Content-Disposition; let the browser pick up
    // the filename. Use a full navigation so cookies + CD trigger download.
    window.location.href = `/api/exports/tax?${qs.toString()}`;
  };

  const refreshAll = () => {
    summary.refresh();
    missing.refresh();
    review.refresh();
  };

  return (
    <div className="tax-hygiene-tab" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <ScopeBar
        scope={scope}
        onChange={handleScopeChange}
        onExport={handleExport}
      />
      <SummaryCards
        rows={summary.data?.data ?? []}
        loading={summary.loading}
        error={summary.error}
      />
      <ReviewQueueSection
        rows={review.data?.data ?? []}
        count={review.data?.count ?? 0}
        loading={review.loading}
        error={review.error}
        tags={tags}
        onUpdated={refreshAll}
      />
      <MissingReceiptsSection
        rows={missing.data?.data ?? []}
        count={missing.data?.count ?? 0}
        loading={missing.loading}
        error={missing.error}
      />
    </div>
  );
}

// ----- Scope bar ---------------------------------------------------------

interface ScopeBarProps {
  scope: TaxScope;
  onChange: (s: TaxScope) => void;
  onExport: () => void;
}

function ScopeBar({ scope, onChange, onExport }: ScopeBarProps) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span className="muted">Scope:</span>
      {SCOPES.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          aria-pressed={scope === s}
          style={{
            padding: '0.25rem 0.75rem',
            border: '1px solid var(--border-color, #ccc)',
            background: scope === s ? 'var(--accent, #2563eb)' : 'transparent',
            color: scope === s ? 'white' : 'inherit',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          {TAX_SCOPE_LABELS[s]}
        </button>
      ))}
      <span style={{ flex: 1 }} />
      <button type="button" onClick={onExport}>
        Export tax CSV
      </button>
    </div>
  );
}

// ----- Summary cards -----------------------------------------------------

interface SummaryCardsProps {
  rows: ReturnType<typeof useTaxSummary>['data'] extends infer T
    ? T extends { data: infer U }
      ? U
      : never
    : never;
  loading: boolean;
  error: string | null;
}

function SummaryCards({ rows, loading, error }: SummaryCardsProps) {
  if (loading) return <p className="muted">Loading summary…</p>;
  if (error) return <p className="error">Failed to load summary: {error}</p>;
  if (rows.length === 0) {
    return <p className="muted">No transactions in this scope/year.</p>;
  }
  return (
    <section>
      <h2>Tax summary</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
        }}
      >
        {rows.map((r) => {
          const reviewedPct =
            r.transactionCount > 0 ? r.reviewedCount / r.transactionCount : 0;
          return (
            <article
              key={r.currency}
              style={{
                border: '1px solid var(--border-color, #ccc)',
                borderRadius: '6px',
                padding: '1rem',
              }}
            >
              <h3 style={{ marginTop: 0 }}>{r.currency}</h3>
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '0.25rem 1rem', margin: 0 }}>
                <dt>Gross</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>{fmtCurrency(r.gross)}</dd>
                <dt>Deductible est.</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>{fmtCurrency(r.deductibleEstimate)}</dd>
                <dt>HST/GST est.</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>{fmtCurrency(r.hstGstEstimate)}</dd>
                <dt>Transactions</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>{r.transactionCount}</dd>
                <dt>Reviewed</dt>
                <dd style={{ margin: 0, textAlign: 'right' }}>
                  {r.reviewedCount} ({fmtPct(reviewedPct)})
                </dd>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// ----- Review queue ------------------------------------------------------

interface ReviewQueueRowDto {
  id: number;
  date: string;
  merchant: string;
  amount: string;
  currency: string;
  finalCategory: string | null;
  finalBusiness: boolean;
  accountName: string | null;
  taxTagId: number | null;
  deductiblePercent: string;
}

interface ReviewQueueSectionProps {
  rows: ReviewQueueRowDto[];
  count: number;
  loading: boolean;
  error: string | null;
  tags: { id: number; name: string }[];
  onUpdated: () => void;
}

function ReviewQueueSection({
  rows,
  count,
  loading,
  error,
  tags,
  onUpdated,
}: ReviewQueueSectionProps) {
  if (loading) return <p className="muted">Loading review queue…</p>;
  if (error) return <p className="error">Failed to load queue: {error}</p>;

  const handleApprove = async (rowId: number) => {
    try {
      await patchTransactionTax(rowId, { reviewedForTax: true });
      onUpdated();
    } catch (e) {
      console.error('Failed to mark reviewed', e);
    }
  };

  const handleTagChange = async (
    rowId: number,
    newTagId: number | null,
  ) => {
    try {
      await patchTransactionTax(rowId, { taxTagId: newTagId });
      onUpdated();
    } catch (e) {
      console.error('Failed to set tag', e);
    }
  };

  return (
    <section>
      <h2>Review queue ({count})</h2>
      {rows.length === 0 ? (
        <p className="muted">Nothing left to review in this scope.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Date</th>
              <th style={{ textAlign: 'left' }}>Merchant</th>
              <th style={{ textAlign: 'right' }}>Amount</th>
              <th style={{ textAlign: 'left' }}>Category</th>
              <th style={{ textAlign: 'left' }}>Tag</th>
              <th style={{ textAlign: 'right' }}>Deductible %</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid var(--border-color, #eee)' }}>
                <td>{r.date}</td>
                <td>
                  {r.merchant}
                  {r.accountName && (
                    <span className="muted"> ({r.accountName})</span>
                  )}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {fmtCurrency(r.amount)} {r.currency}
                </td>
                <td>{r.finalCategory ?? <span className="muted">—</span>}</td>
                <td>
                  <select
                    value={r.taxTagId ?? ''}
                    onChange={(e) =>
                      handleTagChange(
                        r.id,
                        e.target.value === '' ? null : Number(e.target.value),
                      )
                    }
                  >
                    <option value="">— none —</option>
                    {tags.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {fmtPct(Number(r.deductiblePercent))}
                </td>
                <td>
                  <button type="button" onClick={() => handleApprove(r.id)}>
                    Mark reviewed
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ----- Missing receipts --------------------------------------------------

interface MissingReceiptRowDto {
  id: number;
  date: string;
  merchant: string;
  amount: string;
  currency: string;
  finalCategory: string | null;
  accountName: string | null;
}

interface MissingReceiptsSectionProps {
  rows: MissingReceiptRowDto[];
  count: number;
  loading: boolean;
  error: string | null;
}

function MissingReceiptsSection({
  rows,
  count,
  loading,
  error,
}: MissingReceiptsSectionProps) {
  if (loading) return <p className="muted">Loading missing receipts…</p>;
  if (error) return <p className="error">Failed to load missing receipts: {error}</p>;
  return (
    <section>
      <h2>Missing receipts ({count})</h2>
      {rows.length === 0 ? (
        <p className="muted">All business transactions have receipts attached.</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.id}>
              <strong>{r.date}</strong> — {r.merchant} —{' '}
              {fmtCurrency(r.amount)} {r.currency}
              {r.finalCategory && <span className="muted"> ({r.finalCategory})</span>}
              {r.accountName && <span className="muted"> via {r.accountName}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
