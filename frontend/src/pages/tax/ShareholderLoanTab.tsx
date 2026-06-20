import { useState } from 'react';
import { useShareholderLoans, type ShareholderLoanKind, type ShareholderLoanDto } from '../../hooks/useShareholderLoans';
import { useTaxEntities } from '../../hooks/useTaxEntities';
import { Button } from '@connor-adams/designsystem'
import { fmtCurrency } from './util/format';
import { StatCard } from '@/components/ui/stat-card';
import { EmptyState } from '@connor-adams/designsystem'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'

const KIND_LABELS: Record<ShareholderLoanKind, string> = {
  advance: 'Advance (corp to owner)',
  repayment: 'Repayment (owner to corp)',
  dividend_credit: 'Dividend Credit',
  salary_credit: 'Salary Credit',
};

const KIND_OPTIONS: ShareholderLoanKind[] = ['advance', 'repayment', 'dividend_credit', 'salary_credit'];

export function ShareholderLoanTab() {
  const { loans, balance, error, add, refresh } = useShareholderLoans();
  const { entities, error: entitiesError } = useTaxEntities();
  const corpEntity = entities?.find((e) => e.kind === 'corp') ?? null;

  const [date, setDate] = useState('');
  const [kind, setKind] = useState<ShareholderLoanKind>('advance');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!corpEntity) {
      setFormError('No corp entity found. Create one first.');
      return;
    }
    if (!date || !amount) {
      setFormError('Date and amount are required.');
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      await add({
        entityId: corpEntity.id,
        date,
        kind,
        amount,
        description: description.trim() || null,
      });
      setDate('');
      setAmount('');
      setDescription('');
    } catch (e: unknown) {
      setFormError(String((e as Error)?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!corpEntity && !entitiesError) {
    return (
      <div>
        <h2>Shareholder Loans</h2>
        <EmptyState
          title="No corporation found"
          description="Add a corporate entity to track shareholder loans."
        />
      </div>
    );
  }

  return (
    <div>
      <h2>Shareholder Loans</h2>

      <div className="mb-4 max-w-xs">
        <StatCard label="Loan balance" value={fmtCurrency(balance)} />
      </div>

      {(error ?? entitiesError) && (
        <p className="error">Error: {error ?? entitiesError}</p>
      )}

      <section className="mb-6">
        <h3>Add Entry</h3>
        <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-2 max-w-lg">
          <label>
            Date{' '}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </label>
          <label>
            Kind{' '}
            <select value={kind} onChange={(e) => setKind(e.target.value as ShareholderLoanKind)}>
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>{KIND_LABELS[k]}</option>
              ))}
            </select>
          </label>
          <label>
            Amount ({corpEntity?.currency ?? 'CAD'}){' '}
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
            />
          </label>
          <label>
            Description{' '}
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </label>
          {formError && <p className="error">{formError}</p>}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={submitting || !corpEntity}>
              {submitting ? 'Saving…' : 'Add'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { void refresh(); }}>Refresh</Button>
          </div>
        </form>
      </section>

      <section>
        {loans.length === 0 ? (
          <p className="muted">No shareholder loan entries yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loans.map((loan) => (
                <LoanRow key={loan.id} loan={loan} />
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

function LoanRow({ loan }: { loan: ShareholderLoanDto }) {
  return (
    <TableRow>
      <TableCell>{loan.date}</TableCell>
      <TableCell>{KIND_LABELS[loan.kind] ?? loan.kind}</TableCell>
      <TableCell className="text-right tabular-nums">{fmtCurrency(loan.amount)}</TableCell>
      <TableCell>{loan.description ?? '—'}</TableCell>
    </TableRow>
  );
}
