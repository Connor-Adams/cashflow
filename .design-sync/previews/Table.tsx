import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell, Badge } from '@cashflow/ui'

const rows = [
  { date: 'Jun 18', merchant: 'Salary — Acme Corp', cat: 'Income', amount: '+$3,200.00', in: true },
  { date: 'Jun 17', merchant: 'Whole Foods Market', cat: 'Groceries', amount: '−$84.20', in: false },
  { date: 'Jun 16', merchant: 'Hydro Québec', cat: 'Utilities', amount: '−$112.45', in: false },
  { date: 'Jun 15', merchant: 'Netflix', cat: 'Subscriptions', amount: '−$16.99', in: false },
]

export function Transactions() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Merchant</TableHead>
          <TableHead>Category</TableHead>
          <TableHead style={{ textAlign: 'right' }}>Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.merchant}>
            <TableCell style={{ color: 'var(--muted-foreground)' }}>{r.date}</TableCell>
            <TableCell style={{ fontWeight: 600 }}>{r.merchant}</TableCell>
            <TableCell><Badge variant="secondary">{r.cat}</Badge></TableCell>
            <TableCell style={{ textAlign: 'right', fontWeight: 600, color: r.in ? 'var(--positive)' : 'var(--oxblood-500)' }}>
              {r.amount}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
