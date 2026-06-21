/**
 * Server-side CSV export service for the transactions export endpoint.
 *
 * Handles two concerns:
 *   1. Cell-level escaping: RFC 4180 quoting + formula-injection defang.
 *   2. Streaming export: cursor-based pagination via keyset (date DESC, id DESC)
 *      so memory stays bounded regardless of result set size.
 */

import type { Response } from 'express';
import { Op } from 'sequelize';
import { Transaction, Account } from '../models';

/**
 * Fixed CSV column headers for the v1 export.
 * Order matches the row builder in {@link buildExportRow}.
 */
export const EXPORT_HEADERS = [
  'id',
  'date',
  'account',
  'amount',
  'currency',
  'category',
  'description',
  'merchant',
  'status',
  'notes',
] as const;

/**
 * Characters that, when at the start of a cell value, allow spreadsheet tools
 * to interpret the value as a formula. We defang by prepending a single quote.
 * Per OWASP CSV Injection guidance.
 */
const FORMULA_STARTERS = new Set(['=', '+', '-', '@']);

/**
 * Escape a single CSV cell value per RFC 4180 + formula defang.
 *
 * - null/undefined → empty string
 * - values that contain comma, double-quote, CR, or LF → wrapped in quotes
 * - internal double-quotes → doubled
 * - values whose first char is =, +, -, or @ → prefixed with single quote
 *   (defang CSV/spreadsheet formula injection)
 */
export function formatCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;

  // Defang formula injection: prefix leading formula characters with a
  // literal single-quote so the cell is treated as text.
  if (s.length > 0 && FORMULA_STARTERS.has(s[0])) {
    s = `'${s}`;
  }

  // RFC 4180 quoting: wrap in double-quotes if the value contains a
  // comma, double-quote, carriage return, or line feed. Existing
  // double-quotes inside the value are doubled.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }

  return s;
}

/**
 * Serialise a single transaction row into an array of CSV-escaped strings
 * matching {@link EXPORT_HEADERS}.
 */
export function buildExportRow(
  txn: InstanceType<typeof Transaction>,
  accountName: string,
): string[] {
  return [
    formatCsvCell(txn.id),
    formatCsvCell(txn.date),
    formatCsvCell(accountName),
    formatCsvCell(txn.amount),
    formatCsvCell(txn.currency),
    formatCsvCell(txn.finalCategory),
    formatCsvCell(txn.merchantRaw),
    formatCsvCell(txn.merchantClean),
    formatCsvCell(txn.reviewFlag ? 'needs-review' : 'reviewed'),
    formatCsvCell(txn.notes),
  ];
}

/**
 * Format today's date as YYYY-MM-DD for use in the export filename.
 * Accepts an optional `now` override for testing.
 */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Build the `Content-Disposition` header value for the CSV download.
 */
export function exportContentDisposition(date: string = todayIso()): string {
  return `attachment; filename="cashflow-transactions-${date}.csv"`;
}

/**
 * Stream a cursor-paged CSV export to the HTTP response.
 *
 * Uses keyset pagination (ORDER BY date DESC, id DESC, LIMIT batchSize) to
 * bound memory. Each batch is flushed immediately to the response so the
 * browser starts receiving data before all rows are loaded.
 *
 * @param res        Express response object. Caller must not have called
 *                   res.end() or res.json() before this.
 * @param where      Sequelize where clause (already scoped to the household).
 * @param batchSize  Rows per DB round-trip. Default 500.
 * @returns          Number of data rows written (excluding header).
 */
export async function streamCsvExport(
  res: Response,
  where: Record<string, unknown>,
  batchSize = 500,
): Promise<number> {
  const date = todayIso();

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', exportContentDisposition(date));
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  // Write UTF-8 BOM so Excel detects encoding, then the header row.
  const bom = '﻿';
  const headerLine = EXPORT_HEADERS.map(formatCsvCell).join(',');
  res.write(`${bom}${headerLine}\r\n`);

  let rowCount = 0;

  // Keyset cursor: track the last (date, id) pair seen to avoid OFFSET.
  let cursorDate: string | null = null;
  let cursorId: number | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Build keyset condition: first page has no cursor; subsequent pages
    // require (date, id) < (cursorDate, cursorId) in DESC order.
    type PageWhere = Record<string | symbol, unknown>;
    const pageWhere: PageWhere = { ...where };
    if (cursorDate !== null && cursorId !== null) {
      pageWhere[Op.or] = [
        { date: { [Op.lt]: cursorDate } },
        {
          date: { [Op.eq]: cursorDate },
          id: { [Op.lt]: cursorId },
        },
      ];
    }

    const rows = await Transaction.findAll({
      where: pageWhere as Record<string, unknown>,
      include: [{ model: Account, as: 'account', attributes: ['name'] }],
      order: [
        ['date', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: batchSize,
      // Use raw so Sequelize doesn't try to hydrate nested association instances
      // in a way that conflicts with the `include` above — we read `.account`
      // off the Sequelize instance below.
    });

    if (rows.length === 0) break;

    for (const txn of rows) {
      const acc = txn.get('account') as { name: string } | null;
      const accountName = acc?.name ?? '';
      const cells = buildExportRow(txn, accountName);
      res.write(`${cells.join(',')}\r\n`);
      rowCount++;
    }

    // Advance cursor to the last row of this batch.
    const last = rows[rows.length - 1];
    cursorDate = last.date;
    cursorId = last.id;

    if (rows.length < batchSize) break; // Last batch — no more rows.
  }

  res.end();
  return rowCount;
}
