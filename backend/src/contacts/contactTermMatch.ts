import { normalizeContactName } from './normalizeContactName';

export interface MatchableContact {
  id: number;
  name: string;
  normalizedName: string | null;
  aliases: string | null;
}

const MIN_TERM_LEN = 3;

/** Normalized, deduped match terms for a contact: its name plus any aliases.
 *  Terms shorter than 3 chars are dropped to avoid noise substring hits. */
export function contactMatchTerms(c: MatchableContact): string[] {
  const raw = [c.normalizedName ?? normalizeContactName(c.name), ...(c.aliases ?? '').split(',')];
  const terms = new Set<string>();
  for (const t of raw) {
    const n = normalizeContactName(t);
    if (n && n.length >= MIN_TERM_LEN) terms.add(n);
  }
  return [...terms];
}

/** Returns true when `term` appears in `hay` bounded by non-alphanumeric chars
 *  (or string start/end) on both sides. Handles hyphens inside terms correctly:
 *  e.g. `iten-mcgrath` matches when the hay contains it as a whole token. */
function termMatchesBounded(hay: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`);
  return re.test(hay);
}

/** Contact ids whose any term appears as a whole word in the normalized merchant
 *  text (word-boundary match — not raw substring).
 *  1 id = unambiguous, >1 = ambiguous, 0 = no match. */
export function matchContactsByTerms(
  merchantText: string,
  contacts: MatchableContact[],
): number[] {
  const hay = normalizeContactName(merchantText) ?? '';
  if (!hay) return [];
  const out: number[] = [];
  for (const c of contacts) {
    if (contactMatchTerms(c).some((t) => termMatchesBounded(hay, t))) out.push(c.id);
  }
  return out;
}
