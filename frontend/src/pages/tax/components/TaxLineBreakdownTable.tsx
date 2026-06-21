import { useState } from 'react';
import { fmtCurrency } from '../util/format';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@connor-adams/designsystem'

/**
 * Minimal shape shared by T1 (`TaxLineDto`) and T2 (`CorpTaxLineDto`) computed
 * lines — both serialise Decimal to `toFixed(2)` strings and carry the same
 * code/label/amount/inputs/formula shape. The breakdown table renders the same
 * way for both returns, so it lives here instead of being copied per tab.
 */
export type TaxBreakdownLine = {
  code: string;
  label: string;
  amount: string;
  inputs: { source: string; amount: string }[];
  formula?: string;
};

export function TaxLineBreakdownTable({ lines }: { lines: TaxBreakdownLine[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (lines.length === 0) return <p className="muted">No lines to display.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Line</TableHead>
          <TableHead>Label</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.map((l) => (
          <TaxLineRow
            key={l.code}
            line={l}
            expanded={expanded === l.code}
            onClick={() => setExpanded(expanded === l.code ? null : l.code)}
          />
        ))}
      </TableBody>
    </Table>
  );
}

function TaxLineRow({
  line,
  expanded,
  onClick,
}: {
  line: TaxBreakdownLine;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <>
      <TableRow onClick={onClick} className="cursor-pointer">
        <TableCell>{line.code}</TableCell>
        <TableCell>{line.label}</TableCell>
        <TableCell className="text-right tabular-nums">{fmtCurrency(line.amount)}</TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={3}>
            {line.formula && <p className="muted">Formula: {line.formula}</p>}
            <ul>
              {line.inputs.map((inp, idx) => (
                <li key={idx}>
                  {inp.source}: {fmtCurrency(inp.amount)}
                </li>
              ))}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
