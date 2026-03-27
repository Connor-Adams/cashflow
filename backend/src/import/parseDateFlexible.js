const { parse, isValid } = require('date-fns');

/**
 * Try common bank/Amex date formats (US vs CA/UK order differs).
 * @param {string} raw
 * @param {string} [preferredFormat] date-fns format tried first (from profile)
 */
function parseDateFlexible(raw, preferredFormat) {
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
  ].filter(Boolean);

  const seen = new Set();
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

module.exports = { parseDateFlexible };
