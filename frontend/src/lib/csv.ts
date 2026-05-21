/**
 * Tiny CSV helpers for client-side exports.
 *
 * We keep this dependency-free: a Blob + an object URL + a transient anchor
 * is enough to push a file at the browser without a backend round-trip.
 */

/** UTF-8 byte-order mark. Excel needs this to detect UTF-8 reliably. */
const BOM = '﻿'

/**
 * Escape one CSV field. Fields that contain a comma, double-quote, CR, or LF
 * are wrapped in double quotes; inner double-quotes are doubled per RFC 4180.
 * Numbers are emitted as plain numeric strings so spreadsheet tools can sum
 * them without stripping a currency symbol.
 */
export function escapeCsvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const stringified = typeof value === 'number' ? String(value) : value
  if (/[",\n\r]/.test(stringified)) {
    return `"${stringified.replace(/"/g, '""')}"`
  }
  return stringified
}

/**
 * Build a CSV string (with BOM) from a header row and a list of data rows.
 * Rows that are shorter than the header are zero-padded implicitly by the
 * caller — we just join cells per row.
 */
export function buildCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null | undefined)[])[]
): string {
  const headerLine = headers.map(escapeCsvField).join(',')
  const dataLines = rows.map((row) => row.map(escapeCsvField).join(','))
  return `${BOM}${[headerLine, ...dataLines].join('\r\n')}\r\n`
}

/**
 * Trigger a file download for a CSV payload. Creates an object URL, attaches
 * a hidden <a> with the requested filename, clicks it, and revokes the URL.
 * Safe to call from a click handler — synchronous DOM work only.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
