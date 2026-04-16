import { parse } from 'csv-parse/sync';

export function detectDelimiter(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  if (tabs > commas && tabs > 0) return '\t';
  return ',';
}

/** Parse CSV text into row objects (same options as full import). */
export function parseCsvRecords(text: string):
  | { ok: true; records: Record<string, string>[]; headers: string[] }
  | { ok: false; error: string } {
  let t = text;
  if (t.charCodeAt(0) === 0xfeff) {
    t = t.slice(1);
  }
  try {
    const records = parse(t, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      delimiter: detectDelimiter(t),
      relax_column_count: true,
      relax_quotes: true,
    }) as Record<string, string>[];
    const headers = records.length > 0 ? Object.keys(records[0]) : [];
    return { ok: true, records, headers };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'CSV parse failed';
    return { ok: false, error: msg };
  }
}
