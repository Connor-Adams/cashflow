/**
 * Tax Reserve tab — issue #223. Estimates how much cash to set aside per
 * period (monthly / quarterly / annual) for an upcoming tax bill, given the
 * household's business income, deductible business expenses, and any HST/GST
 * collected.
 *
 * The reserve is ONE CAD figure. Canadian tax is paid in CAD and USD client
 * income is converted to CAD on arrival, so the backend converts every
 * transaction to CAD at its own date and applies a single CAD reserve percent.
 *
 * Layout:
 * - Disclaimer banner: this is planning support, NOT tax advice. The
 *   backend repeats the disclaimer in the API response so a programmatic
 *   consumer (chat, AI summary) cannot strip it.
 * - Period picker.
 * - Reserve rate: the household's CAD percent + rationale note.
 * - FX warnings: conversions made on a substituted (stale or post-dated)
 *   exchange rate, or a currency left out for want of any rate.
 * - Summary table: per-period CAD rollup with the computed reserve target.
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
  type ReserveSummaryRow,
} from '../../hooks/useTaxReserve';
import {
  Alert,
  Button,
  Input,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@connor-adams/designsystem';
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
    <div className="tax-reserve-tab flex flex-col gap-6">
      <Disclaimer text={summary.data?.disclaimer} />
      <PeriodicityBar periodicity={periodicity} onChange={setPeriodicity} />
      <SettingsSection
        setting={settings.data?.data[0] ?? null}
        ignored={settings.data?.ignored ?? []}
        loading={settings.loading}
        error={settings.error}
        onChanged={refreshAll}
      />
      <FxWarnings warnings={summary.data?.warnings ?? []} />
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
      className="rounded-[6px] border border-warning bg-warning-bg px-3 py-2 text-sm text-warning-foreground"
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
  setting: ReserveSettingDto | null;
  ignored: ReserveSettingDto[];
  loading: boolean;
  error: string | null;
  onChanged: () => void;
}

function SettingsSection({ setting, ignored, loading, error, onChanged }: SettingsSectionProps) {
  if (loading) return <p className="muted">Loading reserve settings…</p>;
  if (error) return <p className="error">Failed to load settings: {error}</p>;
  return (
    <section className="flex flex-col gap-2">
      <h2>Reserve rate</h2>
      <p className="muted">
        Applied to net business income in CAD. HST/GST owed is reserved in full on top.
      </p>
      {setting && <SettingForm setting={setting} onChanged={onChanged} />}
      {ignored.length > 0 && <LegacyRates rows={ignored} onChanged={onChanged} />}
    </section>
  );
}

function SettingForm({
  setting,
  onChanged,
}: {
  setting: ReserveSettingDto;
  onChanged: () => void;
}) {
  const [percent, setPercent] = useState(String(Number(setting.reservePercent) * 100));
  const [note, setNote] = useState(setting.note ?? '');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Re-sync local form state after a refresh (e.g. following a reset).
  useEffect(() => {
    setPercent(String(Number(setting.reservePercent) * 100));
    setNote(setting.note ?? '');
  }, [setting.reservePercent, setting.note]);

  const run = async (action: () => Promise<unknown>) => {
    setSaving(true);
    setErrorMsg(null);
    try {
      await action();
      onChanged();
    } catch (e) {
      setErrorMsg(String((e as Error)?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    const n = Number(percent);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setErrorMsg('Reserve percent must be between 0 and 100.');
      return;
    }
    void run(() =>
      putReserveSetting({
        reservePercent: n / 100,
        note: note.trim() === '' ? null : note,
      }),
    );
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="w-28">
        <Label htmlFor="tax-reserve-percent">Reserve percent</Label>
        <Input
          id="tax-reserve-percent"
          type="number"
          min="0"
          max="100"
          step="0.5"
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
        />
      </div>
      <div className="min-w-48 flex-1">
        <Label htmlFor="tax-reserve-note">Rationale</Label>
        <Input
          id="tax-reserve-note"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Federal + ON small business rate"
        />
      </div>
      <div className="flex items-center gap-1">
        <Button type="button" variant="primary" size="sm" onClick={handleSave} disabled={saving}>
          Save
        </Button>
        {setting.isDefault ? (
          <span className="muted">(default)</span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void run(() => deleteReserveSetting('CAD'))}
            disabled={saving}
            title="Revert to the default 25% reserve"
          >
            Reset
          </Button>
        )}
      </div>
      {errorMsg && <span className="error">{errorMsg}</span>}
    </div>
  );
}

/** Per-currency rates saved before the reserve became a single CAD figure. */
function LegacyRates({ rows, onChanged }: { rows: ReserveSettingDto[]; onChanged: () => void }) {
  const [removing, setRemoving] = useState(false);
  const label = rows
    .map((r) => `${r.currency} ${fmtPct(Number(r.reservePercent))}`)
    .join(', ');
  const remove = async () => {
    setRemoving(true);
    try {
      await Promise.all(rows.map((r) => deleteReserveSetting(r.currency)));
      onChanged();
    } finally {
      setRemoving(false);
    }
  };
  return (
    <p className="muted">
      Older per-currency rates ({label}) are no longer used: every transaction is
      converted to CAD.{' '}
      <Button type="button" variant="ghost" size="sm" onClick={() => void remove()} disabled={removing}>
        Remove them
      </Button>
    </p>
  );
}

// ----- FX warnings -------------------------------------------------------

function FxWarnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <Alert variant="warning" title="Exchange-rate gaps">
      <ul className="list-disc pl-5">
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </Alert>
  );
}

// ----- Summary section ---------------------------------------------------

interface SummarySectionProps {
  rows: ReserveSummaryRow[];
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
    <section className="flex flex-col gap-2">
      <h2 id="tax-reserve-targets">Reserve targets</h2>
      <p className="muted">
        All amounts in CAD. Transactions in other currencies are converted at
        the Bank of Canada rate for their own date.
      </p>
      <Table aria-labelledby="tax-reserve-targets">
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
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
          {rows.map((r) => {
            const converted = r.sourceCurrencies.filter((c) => c !== 'CAD');
            return (
              <TableRow key={r.period}>
                <TableCell>
                  {r.period}
                  {converted.length > 0 && (
                    <span className="muted ml-1">(incl. {converted.join(', ')})</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {fmtCurrency(r.components.businessIncome)}
                </TableCell>
                <TableCell className="text-right">
                  {fmtCurrency(r.components.deductibleExpenses)}
                </TableCell>
                <TableCell
                  className={`text-right${r.netBusinessIncome < 0 ? ' text-danger' : ''}`}
                >
                  {fmtCurrency(r.netBusinessIncome)}
                </TableCell>
                <TableCell className="text-right">{fmtCurrency(r.netHstGst)}</TableCell>
                <TableCell className="text-right">{fmtPct(r.reservePercent)}</TableCell>
                <TableCell className="text-right">
                  <strong>{fmtCurrency(r.reserveTarget)}</strong>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}
