import { useState } from 'react';
import { useShareholderLoans, type ShareholderLoanKind, type ShareholderLoanDto } from '../../hooks/useShareholderLoans';
import { useTaxEntities } from '../../hooks/useTaxEntities';
import { formatMoney } from '../../lib/formatMoney';

const KIND_LABELS: Record<ShareholderLoanKind, string> = {
  advance: 'Advance (corp to owner)',
  repayment: 'Repayment (owner to corp)',
  dividend_credit: 'Dividend Credit',
  salary_credit: 'Salary Credit',
};

const KIND_OPTIONS: ShareholderLoanKind[] = ['advance', 'repayment', 'dividend_credit', 'salary_credit'];

export function ShareholderLoanTab() {
  const { loans, error, add, refresh } = useShareholderLoans();
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

  return (
    <div>
      <h2>Shareholder Loans</h2>

      {(error ?? entitiesError) && (
        <p className="error">Error: {error ?? entitiesError}</p>
      )}

      {!corpEntity && !entitiesError && (
        <p className="muted">No corp entity found. Create one via POST /api/tax/entities.</p>
      )}

      <section style={{ marginBottom: '1.5rem' }}>
        <h3>Add Entry</h3>
        <form onSubmit={(e) => { void handleSubmit(e); }} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '32rem' }}>
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
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" disabled={submitting || !corpEntity}>
              {submitting ? 'Saving…' : 'Add'}
            </button>
            <button type="button" onClick={() => { void refresh(); }}>Refresh</button>
          </div>
        </form>
      </section>

      <section>
        {loans.length === 0 ? (
          <p className="muted">No shareholder loan entries yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Kind</th>
                <th>Amount</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((loan) => (
                <LoanRow key={loan.id} loan={loan} currency={corpEntity?.currency ?? 'CAD'} />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function LoanRow({ loan, currency }: { loan: ShareholderLoanDto; currency: string }) {
  return (
    <tr>
      <td>{loan.date}</td>
      <td>{KIND_LABELS[loan.kind] ?? loan.kind}</td>
      <td>{formatMoney(Number(loan.amount), currency)}</td>
      <td>{loan.description ?? '—'}</td>
    </tr>
  );
}
