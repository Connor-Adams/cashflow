import { useState } from 'react';
import { useCorpReturn, type CorpTaxLineDto, type CorpTaxReturnDto } from '../../hooks/useCorpReturn';

const CURRENT_YEAR = new Date().getFullYear().toString();

const KEY_TOTAL_LABELS: { key: keyof CorpTaxReturnDto['totals']; label: string }[] = [
  { key: 'netTaxPayable', label: 'Net Tax Payable' },
  { key: 'dividendRefund', label: 'Dividend Refund' },
  { key: 'gripEnding', label: 'GRIP (Ending)' },
  { key: 'cdaEnding', label: 'CDA (Ending)' },
];

export function CorpT2Tab() {
  const [fiscalYear, setFiscalYear] = useState<string>(CURRENT_YEAR);
  const [inputValue, setInputValue] = useState<string>(CURRENT_YEAR);
  const { data, error, loading } = useCorpReturn(fiscalYear);
  const [expanded, setExpanded] = useState<string | null>(null);

  function handleApply() {
    const trimmed = inputValue.trim();
    if (trimmed) setFiscalYear(trimmed);
  }

  return (
    <div>
      <h2>Corp T2</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <label>
          Fiscal Year{' '}
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="e.g. 2024 or 2024-01-01/2024-12-31"
            style={{ width: '18rem' }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleApply(); }}
          />
        </label>
        <button onClick={handleApply}>Load</button>
      </div>

      {loading && <p className="muted">Computing…</p>}
      {error && <p className="error">Error: {error}</p>}

      {!loading && !error && data && (
        <>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
            {KEY_TOTAL_LABELS.map(({ key, label }) => (
              <div
                key={key}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: '0.5rem',
                  padding: '0.75rem 1rem',
                  minWidth: '12rem',
                }}
              >
                <div style={{ fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>{label}</div>
                <div style={{ fontSize: '1.25rem', fontWeight: 600 }}>${data.totals[key]}</div>
              </div>
            ))}
          </div>

          <table>
            <thead>
              <tr><th>Line</th><th>Label</th><th>Amount</th></tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <CorpLineRow
                  key={l.code}
                  line={l}
                  expanded={expanded === l.code}
                  onClick={() => setExpanded(expanded === l.code ? null : l.code)}
                />
              ))}
            </tbody>
          </table>

          {data.warnings.length > 0 && (
            <section style={{ marginTop: '1rem' }}>
              <h3>Warnings</h3>
              <ul>{data.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </section>
          )}

          <p className="muted" style={{ marginTop: '0.5rem' }}>
            {data.cached ? 'Cached snapshot' : 'Freshly computed'} at{' '}
            {new Date(data.computedAt).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}

function CorpLineRow({
  line,
  expanded,
  onClick,
}: {
  line: CorpTaxLineDto;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <>
      <tr onClick={onClick} style={{ cursor: 'pointer' }}>
        <td>{line.code}</td>
        <td>{line.label}</td>
        <td>${line.amount}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={3}>
            {line.formula && <p className="muted">Formula: {line.formula}</p>}
            <ul>
              {line.inputs.map((inp, idx) => (
                <li key={idx}>{inp.source}: ${inp.amount}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}
