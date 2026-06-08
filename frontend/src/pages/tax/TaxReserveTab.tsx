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
import { Button } from '@/components/ui/button';
import { fmtCurrency, fmtPct } from './util/format';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';

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
    <div className="tax-reserve-tab flex flex-col gap-6">
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
      className="rounded-[6px] border border-[var(--warning)] bg-[var(--warning-bg)] px-3 py-2 text-sm text-[var(--warning-foreground)]"
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
    <div className="flex flex-wrap items-center gap-2">
      <span className="muted">Bucket by:</span>
      {PERIODICITIES.map((p) => (
        <Button
          key={p}
          type="button"
          variant={periodicity === p ? 'primary' : 'outline'}
          size="sm"
          onClick={() => onChange(p)}
          aria-pressed={periodicity === p}
        >
          {PERIODICITY_LABELS[p]}
        </Button>
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Currency</TableHead>
              <TableHead className="text-right">Reserve %</TableHead>
              <TableHead>Rationale</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <SettingsRow key={r.currency} row={r} onChanged={onChanged} />
            ))}
          </TableBody>
        </Table>
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
    <TableRow>
      <TableCell>
        <strong>{row.currency}</strong>
        {row.isDefault && (
          <span className="muted ml-1">
            (default)
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <input
          type="number"
          min="0"
          max="100"
          step="0.5"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          className="w-20 text-right"
          aria-label={`Reserve percent for ${row.currency}`}
        />
        <span className="ml-1">%</span>
      </TableCell>
      <TableCell>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Federal + ON sole prop"
          className="w-full"
          aria-label={`Note for ${row.currency}`}
        />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <Button type="button" variant="primary" size="sm" onClick={handleSave} disabled={saving}>
          Save
        </Button>
        {!row.isDefault && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleReset}
            disabled={saving}
            className="ml-1"
            title="Revert to the default 25% reserve"
          >
            Reset
          </Button>
        )}
        {errorMsg && (
          <span className="error ml-2">
            {errorMsg}
          </span>
        )}
      </TableCell>
    </TableRow>
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
            <TableHead>Currency</TableHead>
            <TableHead className="text-right">Income</TableHead>
            <TableHead className="text-right">Deductible exp.</TableHead>
            <TableHead className="text-right">Net income</TableHead>
            <TableHead className="text-right">Net HST/GST</TableHead>
            <TableHead className="text-right">Reserve %</TableHead>
            <TableHead className="text-right">
              <strong>Reserve target</strong>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={`${r.currency}-${r.period}`}>
              <TableCell>{r.period}</TableCell>
              <TableCell>{r.currency}</TableCell>
              <TableCell className="text-right">
                {fmtCurrency(r.components.businessIncome)}
              </TableCell>
              <TableCell className="text-right">
                {fmtCurrency(r.components.deductibleExpenses)}
              </TableCell>
              <TableCell
                className={`text-right${r.netBusinessIncome < 0 ? ' text-[var(--danger)]' : ''}`}
              >
                {fmtCurrency(r.netBusinessIncome)}
              </TableCell>
              <TableCell className="text-right">
                {fmtCurrency(r.netHstGst)}
              </TableCell>
              <TableCell className="text-right">
                {fmtPct(r.reservePercent)}
              </TableCell>
              <TableCell className="text-right">
                <strong>{fmtCurrency(r.reserveTarget)}</strong>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
