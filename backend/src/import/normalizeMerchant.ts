const PROCESSOR_PREFIXES: RegExp[] = [
  /^SQ\s*\*\s*/i,
  /^TST\s*\*\s*/i,
  /^PAYPAL\s*\*\s*/i,
  /^STRIPE\s*\*\s*/i,
  /^GOOGLE\s*\*\s*/i,
  /^GOOGLE\s+\*\s*/i,
  /^DD\s*\*\s*/i,
  /^GH\s*\*\s*/i,
];

const TRAILING_AMZN_MKTP_ID = /\*[A-Z0-9]{4,}$/;
const TRAILING_STORE_NUMBER = /\s+(#\d+|STORE\s*#?\d+|\d{4,6})$/i;
const TRAILING_PHONE = /\s+\+?\d[\d\-.\s()]{6,}\d$/;

// US states and Canadian provinces (2-letter codes used in merchant strings)
const STATE_PROV_SET = new Set([
  // Canadian provinces / territories
  'AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT',
  // US states
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

const COUNTRY_SET = new Set(['US', 'USA', 'CA', 'CAN']);

// All-uppercase word (city name token): 2+ letters, may include apostrophes/hyphens
const ALL_CAPS_WORD = /^[A-Z][A-Z'\-]+$/;

/**
 * Strip trailing city/state/country tokens from a merchant string.
 * Works by scanning backwards through the word list:
 *   1. Skip optional country token (US/CA/...)
 *   2. Skip the state/province 2-letter code
 *   3. Skip up to 2 all-caps city word tokens
 *   4. The remaining words must be non-empty (keep at least 1 word)
 */
function stripCityStateTail(s: string): string {
  const words = s.split(' ');
  let i = words.length - 1;

  // Optional trailing country
  if (i >= 0 && COUNTRY_SET.has(words[i].toUpperCase())) {
    i--;
  }

  // Required state/province code
  if (i < 0 || !STATE_PROV_SET.has(words[i].toUpperCase())) {
    return s; // no state code found — don't strip anything
  }
  i--; // consumed state

  // Optional city words (up to 2), only if all-caps.
  // Require i >= 2 so at least 2 words remain in the merchant name after stripping.
  let cityStripped = 0;
  while (cityStripped < 2 && i >= 2 && ALL_CAPS_WORD.test(words[i])) {
    i--;
    cityStripped++;
  }

  const end = i + 1; // keep words[0..i]

  if (end < 1) return s; // would strip everything — bail out
  return words.slice(0, end).join(' ');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"');
}

export function normalizeMerchant(raw: unknown): string {
  if (raw == null) return '';
  let s = decodeHtmlEntities(String(raw)).trim().replace(/\s+/g, ' ');
  if (!s) return '';

  for (const re of PROCESSOR_PREFIXES) {
    if (re.test(s)) {
      s = s.replace(re, '').trim();
      break;
    }
  }

  s = s.replace(TRAILING_AMZN_MKTP_ID, '').trim();
  s = s.replace(TRAILING_PHONE, '').trim();

  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(TRAILING_STORE_NUMBER, '').trim();
    s = stripCityStateTail(s);
  }

  return s.replace(/\s+/g, ' ').trim();
}
