import { parse, isValid } from 'date-fns';

/**
 * Try common bank/Amex date formats (US vs CA/UK order differs).
 */
export function parseDateFlexible(
  raw: unknown,
  preferredFormat?: string
): Date | null {
  const s = String(raw).trim();
  if (!s) return null;

  const formats = [
    preferredFormat,
    'yyyy-MM-dd',
    'MM/dd/yyyy',
    'M/d/yyyy',
    'MM/d/yyyy',
    'M/dd/yyyy',
    'MM/dd/yy',
    'M/d/yy',
    'dd/MM/yyyy',
    'd/M/yyyy',
    'd/MM/yyyy',
    'dd/M/yyyy',
    'dd/MM/yy',
    'dd-MM-yyyy',
    'd-M-yyyy',
    'dd-MM-yy',
    'MM-dd-yyyy',
    'M-d-yyyy',
    'yyyy/MM/dd',
    'dd.MM.yyyy',
    'dd.MM.yy',
  ].filter((x): x is string => Boolean(x));

  const seen = new Set<string>();
  for (const fmt of formats) {
    if (seen.has(fmt)) continue;
    seen.add(fmt);
    const d = parse(s, fmt, new Date());
    if (isValid(d)) return d;
  }

  const isoTry = new Date(s);
  if (!Number.isNaN(isoTry.getTime())) return isoTry;

  return null;
}
