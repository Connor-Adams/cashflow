/**
 * Tax Reserve tab — issue #223. Estimates how much cash to set aside per
 * currency and per period (monthly / quarterly / annual) for an upcoming
 * tax bill, given the household's business income, deductible business
 * expenses, and any HST/GST collected.
 *
 * Layout:
 * - Period + scope picker.
 * - Settings card: per-currency reserve percent + note editor. Defaults
 *   are synthesised by the backend for currencies the household has
 *   business txns in but no explicit row yet.
 * - Summary table: per-period rollup with the computed reserve target.
 * - Disclaimer banner: this is planning support, NOT tax advice. The
 *   backend repeats the disclaimer in the API response so a programmatic
 *   consumer (chat, AI summary) cannot strip it.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  deleteReserveSetting,
  putReserveSetting,
  useTaxReserveSettings,
  useTaxReserveSummary,
  PERIODICITY_LABELS,
  type Periodicity,
  type ReserveSettingDto,
} from '../../hooks/useTaxReserve';
import { fmtCurrency, fmtPct } from './util/format';

interface Props {
  year: number;
}

const PERIODICITIES: Periodicity[] = ['quarterly', 'monthly', 'annual'];

export function TaxReserveTab({ year }: Props) {
  const [periodicity, setPeriodicity] = useState<Periodicity>('quarterly');
  const filters = useMemo(
    () => ({
      from: `${year}-01-01`,
      to: `${year}-12-31`,
      periodicity,
      scope: 'business',
    }),
    [year, periodicity],
  );
  const settings = useTaxReserveSettings();
  const summary = useTaxReserveSummary(filters);

  const refreshAll = () => {
    settings.refresh();
    summary.refresh();
  };

  return (
    <div
      className="tax-reserve-tab"
      style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}
    >
      <Disclaimer text={summary.data?.disclaimer} />
      <PeriodicityBar
        periodicity={periodicity}
        onChange={setPeriodicity}
      />
      <SettingsSection
        rows={settings.data?.data ?? []}
        loading={settings.loading}
        error={settings.error}
        onChanged={refreshAll}
      />
      <SummarySection
        rows={summary.data?.data ?? []}
        loading={summary.loading}
        error={summary.error}
      />
    </div>
  );
}

// ----- Disclaimer banner -------------------------------------------------

function Disclaimer({ text }: { text?: string }) {
  const body =
    text ??
    'Planning support only. Not tax filing advice. Confirm with your accountant.';
  return (
    <aside
      role="note"
      aria-label="Reserve calculator disclaimer"
      style={{
        border: '1px solid var(--warning-border, #f59e0b)',
        background: 'var(--warning-bg, #fffbeb)',
        color: 'var(--warning-fg, #92400e)',
        borderRadius: '6px',
        padding: '0.5rem 0.75rem',
        fontSize: '0.875rem',
      }}
    >
      <strong>Note:</strong> {body}
    </aside>
  );
}

// ----- Periodicity bar ---------------------------------------------------

function PeriodicityBar({
  periodicity,
  onChange,
}: {
  periodicity: Periodicity;
  onChange: (p: Periodicity) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span className="muted">Bucket by:</span>
      {PERIODICITIES.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          aria-pressed={periodicity === p}
          style={{
            padding: '0.25rem 0.75rem',
            border: '1px solid var(--border-color, #ccc)',
            background:
              periodicity === p ? 'var(--accent, #2563eb)' : 'transparent',
            color: periodicity === p ? 'white' : 'inherit',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          {PERIODICITY_LABELS[p]}
        </button>
      ))}
    </div>
  );
}

// ----- Settings section --------------------------------------------------

interface SettingsSectionProps {
  rows: ReserveSettingDto[];
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}

function SettingsSection({
  rows,
  loading,
  error,
  onChanged,
}: SettingsSectionProps) {
  if (loading) return <p className="muted">Loading reserve settings…</p>;
  if (error) {
    return <p className="error">Failed to load settings: {error}</p>;
  }
  return (
    <section>
      <h2>Reserve rules</h2>
      {rows.length === 0 ? (
        <p className="muted">
          No business transactions yet — add one and refresh, or add a rule
          below.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Currency</th>
              <th style={{ textAlign: 'right' }}>Reserve %</th>
              <th style={{ textAlign: 'left' }}>Rationale</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <SettingsRow key={r.currency} row={r} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SettingsRow({
  row,
  onChanged,
}: {
  row: ReserveSettingDto;
  onChanged: () => void;
}) {
  const [percent, setPercent] = useState(
    String(Number(row.reservePercent) * 100),
  );
  const [note, setNote] = useState(row.note ?? '');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Keep local form state in sync if the row changes (e.g. after refresh
  // following a reset). Without this, edits persist visually after a
  // sibling row's save triggers refetch.
  useEffect(() => {
    setPercent(String(Number(row.reservePercent) * 100));
    setNote(row.note ?? '');
  }, [row.reservePercent, row.note]);

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      const n = Number(percent);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        setErrorMsg('Reserve percent must be between 0 and 100.');
        setSaving(false);
        return;
      }
      await putReserveSetting(row.currency, {
        reservePercent: n / 100,
        note: note.trim() === '' ? null : note,
      });
      onChanged();
    } catch (e) {
      setErrorMsg(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      await deleteReserveSetting(row.currency);
      onChanged();
    } catch (e) {
      setErrorMsg(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <tr style={{ borderBottom: '1px solid var(--border-color, #eee)' }}>
      <td>
        <strong>{row.currency}</strong>
        {row.isDefault && (
          <span className="muted" style={{ marginLeft: '0.25rem' }}>
            (default)
          </span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        <input
          type="number"
          min="0"
          max="100"
          step="0.5"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          style={{ width: '5rem', textAlign: 'right' }}
          aria-label={`Reserve percent for ${row.currency}`}
        />
        <span style={{ marginLeft: '0.25rem' }}>%</span>
      </td>
      <td>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Federal + ON sole prop"
          style={{ width: '100%' }}
          aria-label={`Note for ${row.currency}`}
        />
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        <button type="button" onClick={handleSave} disabled={saving}>
          Save
        </button>
        {!row.isDefault && (
          <button
            type="button"
            onClick={handleReset}
            disabled={saving}
            style={{ marginLeft: '0.25rem' }}
            title="Revert to the default 25% reserve"
          >
            Reset
          </button>
        )}
        {errorMsg && (
          <span className="error" style={{ marginLeft: '0.5rem' }}>
            {errorMsg}
          </span>
        )}
      </td>
    </tr>
  );
}

// ----- Summary section ---------------------------------------------------

interface SummarySectionProps {
  rows: Array<{
    currency: string;
    period: string;
    components: {
      businessIncome: number;
      deductibleExpenses: number;
      hstGstCollected: number;
      hstGstPaid: number;
    };
    netBusinessIncome: number;
    netHstGst: number;
    reservePercent: number;
    reserveTarget: number;
  }>;
  loading: boolean;
  error: string | null;
}

function SummarySection({ rows, loading, error }: SummarySectionProps) {
  if (loading) return <p className="muted">Loading reserve summary…</p>;
  if (error) return <p className="error">Failed to load summary: {error}</p>;
  if (rows.length === 0) {
    return (
      <section>
        <h2>Reserve targets</h2>
        <p className="muted">
          No business transactions in the selected period. Mark transactions
          as business in Tax Hygiene to populate this view.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h2>Reserve targets</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Period</th>
            <th style={{ textAlign: 'left' }}>Currency</th>
            <th style={{ textAlign: 'right' }}>Income</th>
            <th style={{ textAlign: 'right' }}>Deductible exp.</th>
            <th style={{ textAlign: 'right' }}>Net income</th>
            <th style={{ textAlign: 'right' }}>Net HST/GST</th>
            <th style={{ textAlign: 'right' }}>Reserve %</th>
            <th style={{ textAlign: 'right' }}>
              <strong>Reserve target</strong>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.currency}-${r.period}`}
              style={{ borderBottom: '1px solid var(--border-color, #eee)' }}
            >
              <td>{r.period}</td>
              <td>{r.currency}</td>
              <td style={{ textAlign: 'right' }}>
                {fmtCurrency(r.components.businessIncome)}
              </td>
              <td style={{ textAlign: 'right' }}>
                {fmtCurrency(r.components.deductibleExpenses)}
              </td>
              <td
                style={{
                  textAlign: 'right',
                  color: r.netBusinessIncome < 0 ? 'var(--danger, #b91c1c)' : 'inherit',
                }}
              >
                {fmtCurrency(r.netBusinessIncome)}
              </td>
              <td style={{ textAlign: 'right' }}>
                {fmtCurrency(r.netHstGst)}
              </td>
              <td style={{ textAlign: 'right' }}>
                {fmtPct(r.reservePercent)}
              </td>
              <td style={{ textAlign: 'right' }}>
                <strong>{fmtCurrency(r.reserveTarget)}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
