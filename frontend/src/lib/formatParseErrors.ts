/** Formats backend `parseErrors` for display (one line per row). */
export function formatParseErrorLines(
  errors: readonly { rowIndex: number; message: string }[]
): string[] {
  return errors.map((e) => `Row ${e.rowIndex}: ${e.message}`)
}
