import { parse, isValid } from 'date-fns';

// date-fns numeric tokens are lenient: 'yyyy' accepts 1-4 digits, so a
// two-digit-year input like '03/15/25' "successfully" parses as year 0025
// under 'MM/dd/yyyy'. Rejecting implausible years lets the loop fall through
// to the 'yy' formats, which resolve 25 -> 2025.
const MIN_PLAUSIBLE_YEAR = 1900;

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
    if (isValid(d) && d.getFullYear() >= MIN_PLAUSIBLE_YEAR) return d;
  }

  // ISO datetimes (e.g. '2025-01-05T00:00:00Z') must keep the literal calendar
  // date: new Date(s) would parse UTC midnight and the local-time getters used
  // downstream (mapRow, parseStatementFile) shift it a day west of UTC.
  const isoDateTime = /^(\d{4})-(\d{2})-(\d{2})[T ]/.exec(s);
  if (isoDateTime) {
    const y = Number(isoDateTime[1]);
    const mo = Number(isoDateTime[2]);
    const da = Number(isoDateTime[3]);
    const d = new Date(y, mo - 1, da);
    if (
      y >= MIN_PLAUSIBLE_YEAR &&
      d.getMonth() === mo - 1 &&
      d.getDate() === da
    ) {
      return d;
    }
  }

  const isoTry = new Date(s);
  if (
    !Number.isNaN(isoTry.getTime()) &&
    isoTry.getFullYear() >= MIN_PLAUSIBLE_YEAR
  ) {
    return isoTry;
  }

  return null;
}
