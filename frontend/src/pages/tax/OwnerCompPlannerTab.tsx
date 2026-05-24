import { useState } from 'react';
import { useScenario } from '../../hooks/useScenario';

const CURRENT_YEAR = new Date().getFullYear();

function fmt(val: string): string {
  return `$${Number(val).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(val: string): string {
  return `${(Number(val) * 100).toFixed(2)}%`;
}

export function OwnerCompPlannerTab() {
  const { result, error, loading, run } = useScenario();

  const [year, setYear] = useState<number>(CURRENT_YEAR);
  const [salary, setSalary] = useState<string>('0');
  const [eligibleDividends, setEligibleDividends] = useState<string>('0');
  const [nonEligibleDividends, setNonEligibleDividends] = useState<string>('0');

  function handleRun(e: React.FormEvent) {
    e.preventDefault();
    void run({
      year,
      ownerComp: {
        salary: Number(salary),
        eligibleDividends: Number(eligibleDividends),
        nonEligibleDividends: Number(nonEligibleDividends),
      },
    });
  }

  return (
    <div>
      <h2>Owner Comp Planner</h2>
      <p className="muted">
        Model the tax impact of different salary / dividend mixes for a given year.
      </p>

      <form onSubmit={handleRun} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '28rem', marginBottom: '1.5rem' }}>
        <label>
          Year{' '}
          <input
            type="number"
            value={year}
            min={2000}
            max={2100}
            onChange={(e) => setYear(Number(e.target.value))}
          />
        </label>
        <label>
          Salary ($){' '}
          <input
            type="number"
            step="1"
            min="0"
            value={salary}
            onChange={(e) => setSalary(e.target.value)}
            placeholder="0"
          />
        </label>
        <label>
          Eligible Dividends ($){' '}
          <input
            type="number"
            step="1"
            min="0"
            value={eligibleDividends}
            onChange={(e) => setEligibleDividends(e.target.value)}
            placeholder="0"
          />
        </label>
        <label>
          Non-Eligible Dividends ($){' '}
          <input
            type="number"
            step="1"
            min="0"
            value={nonEligibleDividends}
            onChange={(e) => setNonEligibleDividends(e.target.value)}
            placeholder="0"
          />
        </label>
        <div>
          <button type="submit" disabled={loading}>
            {loading ? 'Running…' : 'Run Scenario'}
          </button>
        </div>
      </form>

      {error && <p className="error">Error: {error}</p>}

      {result && (
        <section>
          <h3>Results</h3>
          <table>
            <tbody>
              <tr>
                <td>Corp Net Tax Payable</td>
                <td>{fmt(result.combinedTotals.corpNetTaxPayable)}</td>
              </tr>
              <tr>
                <td>Personal Total Payable</td>
                <td>{fmt(result.combinedTotals.personalTotalPayable)}</td>
              </tr>
              <tr>
                <td>Personal After-Tax Income</td>
                <td>{fmt(result.combinedTotals.personalAfterTaxIncome)}</td>
              </tr>
              <tr>
                <td>Household Total Tax</td>
                <td><strong>{fmt(result.combinedTotals.householdTotalTax)}</strong></td>
              </tr>
              <tr>
                <td>Effective Rate</td>
                <td><strong>{pct(result.combinedTotals.effectiveRate)}</strong></td>
              </tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
