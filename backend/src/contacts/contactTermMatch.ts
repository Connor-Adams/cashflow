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

/** Contact ids whose any term is a substring of the normalized merchant text.
 *  1 id = unambiguous, >1 = ambiguous, 0 = no match. */
export function matchContactsByTerms(
  merchantText: string,
  contacts: MatchableContact[],
): number[] {
  const hay = normalizeContactName(merchantText) ?? '';
  if (!hay) return [];
  const out: number[] = [];
  for (const c of contacts) {
    if (contactMatchTerms(c).some((t) => hay.includes(t))) out.push(c.id);
  }
  return out;
}
