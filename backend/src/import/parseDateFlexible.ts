import { parse, isValid } from 'date-fns';

// date-fns numeric tokens are lenient: 'yyyy' accepts 1-4 digits, so a
// two-digit-year input like '03/15/25' "successfully" parses as year 0025
// under 'MM/dd/yyyy'. Rejecting implausible years lets the loop fall through
// to the 'yy' formats, which resolve 25 -> 2025.
const MIN_PLAUSIBLE_YEAR = 1900;

/** Day/month ordering for ambiguous numeric dates ('03/04/2025'). */
export type DateOrdering = 'month-first' | 'day-first';

const MONTH_FIRST_FORMATS = [
  'MM/dd/yyyy',
  'M/d/yyyy',
  'MM/d/yyyy',
  'M/dd/yyyy',
  'MM/dd/yy',
  'M/d/yy',
  'MM-dd-yyyy',
  'M-d-yyyy',
  'MM-dd-yy',
];

const DAY_FIRST_FORMATS = [
  'dd/MM/yyyy',
  'd/M/yyyy',
  'd/MM/yyyy',
  'dd/M/yyyy',
  'dd/MM/yy',
  'dd-MM-yyyy',
  'd-M-yyyy',
  'dd-MM-yy',
  'dd.MM.yyyy',
  'dd.MM.yy',
];

/** dd/MM vs MM/dd numeric date with /, - or . separators. */
const NUMERIC_DATE_RE = /^(\d{1,2})[/\-.](\d{1,2})[/\-.]\d{2,4}$/;

/**
 * Infer a file-wide day/month ordering by scanning date cells for unambiguous
 * tokens: a first component >12 proves day-first ('15/03'), a second
 * component >12 proves month-first ('03/15'). Returns null when there is no
 * evidence or the evidence conflicts (then the per-token default applies).
 */
export function inferDateOrdering(values: Iterable<unknown>): DateOrdering | null {
  let dayFirst = 0;
  let monthFirst = 0;
  for (const raw of values) {
    const m = NUMERIC_DATE_RE.exec(String(raw ?? '').trim());
    if (!m) continue;
    const first = Number(m[1]);
    const second = Number(m[2]);
    if (first > 12 && second <= 12) dayFirst += 1;
    else if (second > 12 && first <= 12) monthFirst += 1;
  }
  if (dayFirst > 0 && monthFirst === 0) return 'day-first';
  if (monthFirst > 0 && dayFirst === 0) return 'month-first';
  return null;
}

/**
 * Try common bank/Amex date formats (US vs CA/UK order differs).
 *
 * Ambiguous numeric dates default to month-first for every separator. Pass
 * `ordering` (see inferDateOrdering) to resolve a whole file under one
 * day/month ordering; `preferredFormat` (profile.dateFormat) still wins.
 */
export function parseDateFlexible(
  raw: unknown,
  preferredFormat?: string,
  ordering?: DateOrdering | null
): Date | null {
  const s = String(raw).trim();
  if (!s) return null;

  const orderingFormats =
    ordering === 'day-first'
      ? DAY_FIRST_FORMATS
      : ordering === 'month-first'
        ? MONTH_FIRST_FORMATS
        : [];

  const formats = [
    preferredFormat,
    'yyyy-MM-dd',
    ...orderingFormats,
    ...MONTH_FIRST_FORMATS,
    ...DAY_FIRST_FORMATS,
    'yyyy/MM/dd',
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
