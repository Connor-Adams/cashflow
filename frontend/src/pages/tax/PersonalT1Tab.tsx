import { useState } from 'react';
import { useTaxReturn, type TaxLineDto } from '../../hooks/useTaxReturn';

const YEAR = new Date().getUTCFullYear();

export function PersonalT1Tab() {
  const { data, error, loading } = useTaxReturn(YEAR);
  const [expanded, setExpanded] = useState<string | null>(null);
  if (loading) return <p className="muted">Computing…</p>;
  if (error) return <p className="error">Error: {error}</p>;
  if (!data) return null;
  return (
    <div>
      <h2>Personal T1 — {YEAR}</h2>
      <table>
        <thead>
          <tr><th>Line</th><th>Label</th><th>Amount</th></tr>
        </thead>
        <tbody>
          {data.lines.map((l) => (
            <LineRow key={l.code} line={l} expanded={expanded === l.code} onClick={() => setExpanded(expanded === l.code ? null : l.code)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LineRow({ line, expanded, onClick }: { line: TaxLineDto; expanded: boolean; onClick: () => void }) {
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
              {line.inputs.map((i, idx) => (
                <li key={idx}>{i.source}: ${i.amount}</li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}
