import { useState } from 'react';
import { useInstalments } from '../../hooks/useInstalments';

type Props = {
  year: number;
};

const QUARTER_OPTIONS = [
  { value: '1', label: 'Q1 (Mar 15)' },
  { value: '2', label: 'Q2 (Jun 15)' },
  { value: '3', label: 'Q3 (Sep 15)' },
  { value: '4', label: 'Q4 (Dec 15)' },
  { value: '', label: 'Other' },
];

export function InstalmentTracker({ year }: Props) {
  const { items, error, add } = useInstalments(year);

  const [quarter, setQuarter] = useState<string>('1');
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState('');
  const [notes, setNotes] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!amount || !paidOn) {
      setSubmitError('Amount and paid-on date are required.');
      return;
    }
    setSubmitting(true);
    try {
      await add({
        quarter: quarter !== '' ? Number(quarter) : null,
        amount,
        paidOn,
        notes: notes || null,
      });
      setAmount('');
      setPaidOn('');
      setNotes('');
      setQuarter('1');
    } catch (e) {
      setSubmitError(String((e as Error)?.message ?? e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h3>Instalment payments — {year}</h3>

      {error && <p className="error">Error loading instalments: {error}</p>}

      {items.length === 0 ? (
        <p className="muted">No instalment payments recorded for {year}.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Paid On</th>
              <th>Quarter</th>
              <th>Amount</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.paidOn}</td>
                <td>{item.quarter != null ? `Q${item.quarter}` : 'Other'}</td>
                <td>${parseFloat(item.amount).toFixed(2)}</td>
                <td>{item.notes ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={handleSubmit} style={{ marginTop: '1rem' }}>
        <h4>Record a payment</h4>
        <div style={{ display: 'grid', gap: '0.5rem', maxWidth: '400px' }}>
          <label>
            Quarter
            <select value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              {QUARTER_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            Amount ($)
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              required
            />
          </label>
          <label>
            Paid on
            <input
              type="date"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
              required
            />
          </label>
          <label>
            Notes
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Optional notes…"
            />
          </label>
          {submitError && <p className="error">{submitError}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Add payment'}
          </button>
        </div>
      </form>
    </div>
  );
}
