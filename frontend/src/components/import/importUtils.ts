import type { AlertVariant } from '@connor-adams/designsystem'

type DetectedMode = 'standard' | 'ws-bundle' | 'holdings' | 'pdf-bundle'

type UploadResult = {
  file?: string
  inserted?: number | null
  insertedTransactions?: number | null
  insertedInvestmentActivities?: number | null
  insertedHoldings?: number | null
  skippedDuplicates?: number | null
  rowErrors?: number | null
  batchLabel?: string | null
  warning?: string
  warnings?: string[]
  skipped?: boolean
  reason?: string | null
  message?: string | null
  parseErrors?: { rowIndex: number; message: string }[]
  error?: string | null
}

// Wealthsimple bulk-export filename patterns. Mirror of
// backend/src/import/parseWealthsimpleFilename.ts (CREDIT_CARD_RE / MONTHLY_RE) —
// keep in sync.
const WS_CREDIT_CARD_RE =
  /^Wealthsimple-credit-card-\d{4}-\d{2}-\d{2}-credit-card-statement-transactions-ca-credit-card-[A-Za-z0-9]+\.csv$/
const WS_MONTHLY_RE =
  /^.+?-\d{4}-\d{2}-\d{2}-monthly-statement-transactions-[A-Za-z0-9]+CAD?\.csv$/

function isWealthsimpleExport(name: string): boolean {
  return WS_CREDIT_CARD_RE.test(name) || WS_MONTHLY_RE.test(name)
}

export function detectMode(files: File[]): DetectedMode {
  if (files.length === 0) return 'standard'
  const allPdf = files.every((f) => f.name.toLowerCase().endsWith('.pdf'))
  if (allPdf) return 'pdf-bundle'
  const allCsv = files.every((f) => f.name.toLowerCase().endsWith('.csv'))
  if (allCsv) {
    if (
      files.length === 1 &&
      /holdings|positions/i.test(files[0].name)
    ) {
      return 'holdings'
    }
    // Only auto-route to the WS bundle importer when every file is a recognized
    // Wealthsimple bulk export. A mix, or a look-alike bank file, stays standard.
    if (files.every((f) => isWealthsimpleExport(f.name))) return 'ws-bundle'
  }
  return 'standard'
}

/**
 * Build the feedback banner for a single-file standard import. A parse-only
 * failure (0 rows inserted, rows errored) is surfaced as a loud error with a
 * wrong-profile hint, instead of the old quiet "Imported 0 row(s)" success that
 * made a totally-failed import look fine.
 */
export function singleImportFeedback(
  result: UploadResult,
  profileId: string,
): { variant: AlertVariant; title: string } {
  if (result.skipped) {
    return {
      variant: 'warning',
      title: `Skipped (${result.reason ?? 'unknown'}) — ${result.message ?? ''}`,
    }
  }
  const inserted = result.inserted ?? 0
  const rowErrors = result.rowErrors ?? result.parseErrors?.length ?? 0
  if (inserted === 0 && rowErrors > 0) {
    const prof =
      profileId && profileId !== 'auto' ? ` using the "${profileId}" profile` : ''
    return {
      variant: 'error',
      title: `Import failed — 0 of ${rowErrors} row(s) could be parsed${prof}. This usually means the wrong CSV profile; switch the profile to "Auto" or a bank-specific one and re-import.`,
    }
  }
  return {
    variant: rowErrors > 0 ? 'warning' : 'success',
    title: `Imported ${inserted} row(s) · batch "${result.batchLabel ?? ''}" · dupes ${result.skippedDuplicates ?? 0}${rowErrors > 0 ? ` · ${rowErrors} parse error(s)` : ''}`,
  }
}
