/**
 * Fully synthetic statement / receipt layouts for the PDF parser tests.
 *
 * Every value here is made up: card last-4s, store numbers, merchants, towns,
 * dates, amounts, account numbers and the holder name. Only the LAYOUT mirrors
 * the real documents (labels, section headers, column order, wrap shapes), as
 * encoded in the parsers themselves. Never paste text from a real statement
 * into this file; the real PDFs are private and gitignored.
 *
 * Each export is a `SynthPage[]`: feed `synthPdfLines(x)` to a parser, or
 * `synthPdf(x)` to anything that needs PDF bytes (see ./syntheticPdf.ts).
 */
import { right, type SynthCell, type SynthPage, type SynthRow } from './syntheticPdf';

// ─── CIBC Costco Mastercard statements ───────────────────────────────────────

/** Made-up card last-4 used by every synthetic CIBC statement. */
export const SYN_CIBC_LAST4 = '9001';
const CARD = `5160 XXXX XXXX ${SYN_CIBC_LAST4}`;
const AMOUNT_END = 125;

type CibcRowCells = { trans: string; post: string };
type CibcPayment = CibcRowCells & { desc: string; amount: string };
type CibcInterest = CibcRowCells & { desc: string; rate: string; amount: string };
type CibcCharge = CibcRowCells & {
  merchant: string;
  city: string;
  prov: string;
  category: string;
  amount: string;
};

const dateCells = (r: CibcRowCells): SynthRow => [[0, r.trans], [10, r.post]];
const columnHeader = (label?: string): SynthRow[] => [
  [[0, 'Trans'], [10, 'Post']],
  [[0, 'date'], [10, 'date'], [20, 'Description'], ...(label ? [[70, label] as SynthCell] : []), right(AMOUNT_END, 'Amount($)')],
];

type CibcStatement = {
  /** Page-1 header rows (title, statement date, period, card number, summary). */
  header: SynthRow[];
  /** Period as printed above the transactions ("Transactions from …"). */
  transactionsFrom: string;
  payments?: { rows: CibcPayment[]; total: string };
  interest?: { rows: CibcInterest[]; total: string };
  charges?: { rows: CibcCharge[]; total: string };
};

function cibcPages(s: CibcStatement): SynthPage[] {
  const p2: SynthRow[] = [[[0, `Transactions from ${s.transactionsFrom}`]], []];
  if (s.payments) {
    p2.push([[0, 'Your payments']], ...columnHeader());
    for (const r of s.payments.rows) p2.push([...dateCells(r), [20, r.desc], right(AMOUNT_END, r.amount)]);
    p2.push([[0, 'Total payments'], right(AMOUNT_END, s.payments.total)], []);
  }
  if (s.interest) {
    p2.push([[0, 'Your interest']], ...columnHeader('Annual interest rate'));
    for (const r of s.interest.rows) {
      p2.push([...dateCells(r), [20, r.desc], [70, r.rate], right(AMOUNT_END, r.amount)]);
    }
    p2.push([[0, 'Total interest'], right(AMOUNT_END, s.interest.total)], []);
  }
  if (s.charges) {
    p2.push([[0, 'Your new charges and credits']], ...columnHeader('Spend Categories'), [[0, `Card number ${CARD}`]]);
    for (const r of s.charges.rows) {
      p2.push([...dateCells(r), [20, r.merchant], [50, r.city], [64, r.prov], [70, r.category], right(AMOUNT_END, r.amount)]);
    }
    p2.push([[0, `Total for ${CARD}`], right(AMOUNT_END, s.charges.total)], []);
    p2.push([[0, 'Ý Identifies transactions that earn bonus rewards at the']], [[0, 'same rate.']]);
  }
  return [s.header, p2];
}

const summaryRows = (balance: string): SynthRow[] => [
  [],
  [[0, 'Account number'], [40, CARD]],
  [[0, 'Previous balance'], right(70, '$0.00')],
  [[0, 'New balance'], right(70, balance)],
  [[0, 'Minimum payment'], right(70, '$10.00')],
];

/**
 * Statement A: same-year period printed in the abbreviated form
 * ("April 13 to May 12, 2024"), all three sub-sections with one row each.
 */
export const SYN_CIBC_A: SynthPage[] = cibcPages({
  header: [
    [[0, 'CIBC Costco Mastercard']],
    [[0, 'Statement Date'], [40, 'May 12, 2024']],
    [[0, 'April statement period'], [40, 'April 13 to May 12, 2024']],
    ...summaryRows('$0.00'),
  ],
  transactionsFrom: 'April 13 to May 12, 2024',
  payments: {
    rows: [{ trans: 'Apr 28', post: 'Apr 30', desc: 'PAYMENT THANK YOU/PAIEMENT MERCI', amount: '25.00' }],
    total: '$25.00',
  },
  interest: {
    rows: [{ trans: 'May 12', post: 'May 12', desc: 'REGULAR PURCHASES', rate: '20.99%', amount: '0.42' }],
    total: '$0.42',
  },
  charges: {
    rows: [{
      trans: 'Apr 24', post: 'Apr 25', merchant: 'SAMPLE CLOUD STORAGE', city: 'ANYTOWN', prov: 'ON',
      category: 'Personal and Household Expenses', amount: '4.99',
    }],
    total: '$4.99',
  },
});

/**
 * Statement B: Statement Date value on the line AFTER its label, no
 * "statement period" line on page 1 (the period comes from the
 * "Transactions from" line), an empty payments section, five charges
 * including a Ý bonus-rewards row.
 */
export const SYN_CIBC_B: SynthPage[] = cibcPages({
  header: [
    [[0, 'CIBC Costco Mastercard']],
    [[0, 'Statement Date']],
    [[0, 'June 12, 2024']],
    ...summaryRows('$412.37'),
  ],
  transactionsFrom: 'May 13 to June 12, 2024',
  payments: { rows: [], total: '$0.00' },
  charges: {
    rows: [
      { trans: 'May 14', post: 'May 15', merchant: 'COSTCO WHOLESALE W0001', city: 'ANYTOWN', prov: 'ON', category: 'Retail and Grocery', amount: '212.48' },
      { trans: 'May 20', post: 'May 21', merchant: 'Ý COSTCO GAS W0001', city: 'ANYTOWN', prov: 'ON', category: 'Transportation', amount: '58.10' },
      { trans: 'May 27', post: 'May 28', merchant: 'SAMPLE HARDWARE #42', city: 'ANYTOWN', prov: 'ON', category: 'Home and Office Improvement', amount: '36.15' },
      { trans: 'Jun 02', post: 'Jun 03', merchant: 'SAMPLE PHARMACY 77', city: 'ANYTOWN', prov: 'ON', category: 'Health and Education', amount: '19.99' },
      { trans: 'Jun 09', post: 'Jun 10', merchant: 'SAMPLE BISTRO', city: 'ANYTOWN', prov: 'ON', category: 'Restaurants', amount: '85.65' },
    ],
    total: '$412.37',
  },
});

/**
 * Statement C: year-rollover period printed fully qualified
 * ("December 13, 2023 to January 12, 2024"); a payment whose transaction and
 * posting dates differ, and five charges on both sides of the year boundary.
 */
export const SYN_CIBC_C: SynthPage[] = cibcPages({
  header: [
    [[0, 'CIBC Costco Mastercard']],
    [[0, 'Statement Date'], [40, 'January 12, 2024']],
    [[0, 'December statement period'], [40, 'December 13, 2023 to January 12, 2024']],
    ...summaryRows('$1,200.00'),
  ],
  transactionsFrom: 'December 13, 2023 to January 12, 2024',
  payments: {
    rows: [{ trans: 'Dec 22', post: 'Dec 27', desc: 'PAYMENT THANK YOU/PAIEMENT MERCI', amount: '300.00' }],
    total: '$300.00',
  },
  charges: {
    rows: [
      { trans: 'Dec 14', post: 'Dec 15', merchant: 'COSTCO WHOLESALE W0001', city: 'ANYTOWN', prov: 'ON', category: 'Retail and Grocery', amount: '1,204.30' },
      { trans: 'Dec 19', post: 'Dec 20', merchant: 'COSTCO WHOLESALE W0001', city: 'ANYTOWN', prov: 'ON', category: 'Retail and Grocery', amount: '88.12' },
      { trans: 'Dec 30', post: 'Jan 02', merchant: 'SAMPLE TRANSIT', city: 'ANYTOWN', prov: 'ON', category: 'Transportation', amount: '45.00' },
      { trans: 'Jan 02', post: 'Jan 03', merchant: 'COSTCO ANNUAL RENEWAL', city: 'ANYTOWN', prov: 'ON', category: 'Retail and Grocery', amount: '120.00' },
      { trans: 'Jan 08', post: 'Jan 09', merchant: 'SAMPLE BOOKSHOP', city: 'ANYTOWN', prov: 'ON', category: 'Retail and Grocery', amount: '42.58' },
    ],
    total: '$1,500.00',
  },
});

// ─── Costco warehouse till receipts ──────────────────────────────────────────

const PRICE_END = 48;
type Item = [id: string, name: string, price: string, flag?: 'Y' | 'N'];

function itemRow([id, name, price, flag]: Item): SynthRow {
  const row: SynthRow = [[2, id]];
  if (name) row.push([12, name]);
  row.push(right(PRICE_END, price));
  if (flag) row.push([50, flag]);
  return row;
}
const text = (s: string, col = 12): SynthRow => [[col, s]];
const amountRow = (label: string, amount: string, col = 12): SynthRow => [[col, label], right(PRICE_END, amount)];
const receiptHeader: SynthRow[] = [
  [[14, 'COSTCO WHOLESALE']],
  [[16, 'ANYTOWN #0999']],
  [[14, '100 SAMPLE ROAD']],
  [[14, 'ANYTOWN, ON A1A 1A1']],
  [],
  [[2, 'Member']],
  [[2, '111122223333']],
];
const footer = (date: string, trm: string, trn: string, opt: string): SynthRow => [
  [2, date], [22, '0999'], [28, trm], [32, trn], [37, opt],
];

/**
 * R1: single tender on one masked card, two instant-savings (TPD) discount
 * lines, one item name wrapped around its numeric row. Order id
 * 0999-11-303-23-20240504-1107, total 547.64 on card 9001.
 */
export const SYN_COSTCO_R1: SynthPage[] = [
  [
    ...receiptHeader,
    itemRow(['1000001', 'SAMPLE WIDGET', '29.99', 'Y']),
    itemRow(['1000002', 'FRUIT TRAY', '12.49', 'N']),
    text('HOT'),
    itemRow(['2000003', '', '9.99', 'N']),
    text('SAUCE'),
    itemRow(['1000004', 'LARGE APPLIANCE', '499.99', 'Y']),
    itemRow(['1000005', 'TPD/1000004', '100.00-']),
    itemRow(['1000006', 'SAMPLE COFFEE', '18.99', 'N']),
    itemRow(['1000007', 'TPD/1000006', '3.00-']),
    itemRow(['1000008', 'PAPER TOWEL', '24.99', 'Y']),
    amountRow('SUBTOTAL', '493.44'),
    amountRow('TAX', '54.20'),
    [[2, '****'], [12, 'TOTAL'], right(PRICE_END, '547.64')],
    [[2, 'XXXXXXXXXXXX9001'], [24, 'CHIP read']],
    text('APPROVED - PURCHASE', 2),
    text('AMOUNT: $547.64', 2),
    amountRow('COSTCO MASTERCARD', '547.64', 2),
    amountRow('CHANGE', '0.00', 2),
    amountRow('(A) HST 13%', '54.20', 2),
    amountRow('TOTAL TAX', '54.20', 2),
    text('TOTAL NUMBER OF ITEMS SOLD = 6', 2),
    footer('05/04/2024 11:07', '11', '303', '23'),
  ],
  [
    [[2, 'whse: 0999'], [20, 'Trm: 11']],
    [[2, 'Items Sold: 6']],
    [[2, 'Thank You! Please Come Again']],
  ],
];

/**
 * R2: split tender (first card masked, second unmasked) printed on the second
 * page, a comma-thousands amount, a TPD discount and a bottle deposit whose
 * name wraps around its numeric row. Order id 0999-7-285-17-20240615-1546,
 * total 1,988.22 = 1,200.00 (card 4242) + 788.22 (Costco Mastercard).
 */
export const SYN_COSTCO_R2: SynthPage[] = [
  [
    ...receiptHeader,
    itemRow(['3000001', 'SAMPLE TV 65IN', '1,899.99', 'Y']),
    itemRow(['3000002', 'TPD/3000001', '200.00-']),
    itemRow(['3000004', 'SPARKLING WATER 24PK', '9.99', 'N']),
    text('DEPOSIT'),
    itemRow(['4002', '', '2.40']),
    text('VL/3000004'),
    itemRow(['3000005', 'SAMPLE OLIVE OIL', '21.49', 'N']),
    itemRow(['3000006', 'HDMI CABLE 2PK', '29.99', 'Y']),
    amountRow('SUBTOTAL', '1,763.86'),
    amountRow('TAX', '224.36'),
    [[2, '****'], [12, 'TOTAL'], right(PRICE_END, '1,988.22')],
  ],
  [
    [[2, 'XXXXXXXXXXXX4242'], [24, 'CHIP read']],
    text('APPROVED - PURCHASE', 2),
    text('AMOUNT: $1,200.00', 2),
    amountRow('MASTER CARD', '1,200.00', 2),
    amountRow('COSTCO MASTERCARD', '788.22', 2),
    amountRow('CHANGE', '0.00', 2),
    text('TOTAL NUMBER OF ITEMS SOLD = 5', 2),
    footer('06/15/2024 15:46', '7', '285', '17'),
    [[2, 'whse: 0999'], [20, 'Trm: 7']],
    [[2, 'Items Sold: 5']],
  ],
];

/**
 * R3: four `<qty> @ <unit>` continuation lines spread over three pages, one
 * of them split from its item by the page break, and one ahead of a deposit
 * whose name wraps around its row. Order id 0999-8-492-36-20240213-2013,
 * subtotal 81.13, total 89.49.
 */
export const SYN_COSTCO_R3: SynthPage[] = [
  [
    ...receiptHeader,
    text('2 @ 15.99', 2),
    itemRow(['5000001', 'SAMPLE COLA 24PK', '31.98', 'Y']),
    text('2 @ 6.49', 2),
    itemRow(['5000002', 'LACTOSE FREE MILK', '12.98', 'N']),
    itemRow(['5000003', 'SAMPLE BREAD 2PK', '7.99', 'N']),
    text('2 @ 13.99', 2),
  ],
  [
    itemRow(['5000004', 'SAMPLE RED WINE', '27.98', 'Y']),
    text('2 @ 0.10', 2),
    text('DEPOSIT'),
    itemRow(['4003', '', '0.20']),
    text('VL/5000004'),
    amountRow('SUBTOTAL', '81.13'),
    amountRow('TAX', '8.36'),
    [[2, '****'], [12, 'TOTAL'], right(PRICE_END, '89.49')],
  ],
  [
    [[2, 'XXXXXXXXXXXX9001'], [24, 'CHIP read']],
    amountRow('COSTCO MASTERCARD', '89.49', 2),
    amountRow('CHANGE', '0.00', 2),
    footer('02/13/2024 20:13', '8', '492', '36'),
    [[2, 'Items Sold: 5']],
  ],
];

// ─── Wealthsimple brokerage statement ────────────────────────────────────────

/** Made-up WS account number (2 letters + alnum + currency, like the real ones). */
export const SYN_WS_ACCOUNT = 'ZZSYNTH01CAD';
/** A filename shaped like the real statement exports (no WSID in it). */
export const SYN_WS_FILENAME = `${SYN_WS_ACCOUNT}_2024-05_BROKERAGE.pdf`;

/**
 * Self-directed TFSA: two Canadian holdings, then a CONT, a wrapped BUY and an
 * FPLINT activity row.
 */
export const SYN_WS_BROKERAGE: SynthPage[] = [
  [
    [[0, 'ORDER EXECUTION ONLY ACCOUNT']],
    [[0, 'All figures in $CAD unless otherwise specified']],
    [[0, 'Account No.'], [20, 'Owner'], [45, 'Statement Period']],
    [[0, SYN_WS_ACCOUNT], [20, 'Pat Example'], [45, '2024-05-01 - 2024-05-31']],
    [],
    [[0, 'Tax-Free Savings SDI Cash Account']],
    [],
    [[0, 'This statement is being issued to you by Wealthsimple Investments Inc.']],
  ],
  [
    [[0, 'Portfolio Equities']],
    [[0, 'Symbol'], [36, 'Total Quantity'], [52, 'Segregated'], [64, 'Quantity on'], [78, 'Market'], [92, 'Market'], [106, 'Book']],
    [[52, 'Quantity'], [64, 'Loan'], [78, 'Price* ($)'], [92, 'Value ($)'], [106, 'Cost* ($)']],
    [[0, 'Canadian Equities and Alternatives']],
    [[0, 'Sample Index ETF'], [28, 'SMPL'], [36, '10.0000'], [52, '10.0000'], [64, '0.0000'], [78, '$25.00 CAD'], [92, '$250.00'], [106, '$240.00']],
    [[0, 'Example Bank Corp'], [28, 'EXBK'], [36, '2.5000'], [52, '2.5000'], [64, '0.0000'], [78, '$80.00 CAD'], [92, '$200.00'], [106, '$190.00']],
    [[0, 'Total'], [92, '$450.00'], [106, '$430.00']],
    [],
    [[0, 'Activity - Current period']],
    [[0, 'Date'], [12, 'Transaction'], [26, 'Description'], [92, 'Debit ($)'], [104, 'Credit ($)'], [116, 'Balance ($)']],
    [[0, '2024-05-02'], [12, 'CONT'], [26, 'Contribution (executed at 2024-05-02)'], [92, '$0.00'], [104, '$100.00'], [116, '$100.00']],
    [[0, '2024-05-03'], [12, 'BUY'], [26, 'SMPL - Sample Index ETF: Bought 2.0000 shares (executed at'], [92, '$50.00'], [104, '$0.00'], [116, '$50.00']],
    [[0, '2024-05-03)']],
    [[0, '2024-05-15'], [12, 'FPLINT'], [26, 'Stock lending monthly interest payment'], [92, '$0.00'], [104, '$0.01'], [116, '$50.01']],
  ],
];

// ─── A PDF no statement parser recognises ────────────────────────────────────

/** Stand-in for a non-statement PDF (e.g. a yearly performance report). */
export const SYN_UNRECOGNIZED: SynthPage[] = [
  [
    [[0, 'Sample Annual Performance Summary']],
    [[0, 'Period'], [20, '2024-01-01 to 2024-12-31']],
    [[0, 'Rate of return'], [20, '4.2%']],
  ],
];
