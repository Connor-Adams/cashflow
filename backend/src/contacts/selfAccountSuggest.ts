/**
 * Pure helper for auto-suggesting contacts that are likely the user's own
 * identity (self-accounts). A contact is "self-like" when its name tokens
 * overlap the user's own name tokens or the household's account name tokens.
 *
 * Self-account detection flow:
 *   1. GET /api/contacts/self-suggestions calls this to surface candidates.
 *   2. User reviews and confirms via PATCH /api/contacts/:id { isSelf: true }.
 *   3. Confirmed self-accounts are excluded from the transfer-link pass
 *      (transferContactLink.ts) so "Connor Adams RBC" never accumulates ledger
 *      entries against the user's own transfers to their own account.
 *
 * Spine note: operates on the Contact primitive; no new primitive introduced.
 */

export interface SuggestableContact {
  id: number;
  name: string;
  normalizedName: string | null;
  isSelf: boolean;
}

/**
 * Lowercase, split on non-alphanumeric runs, keep tokens of length >= 3.
 * Mirrors the intent of normalizeContactName (lowercase) but also tokenizes.
 * "Connor Adams RBC" → ["connor", "adams", "rbc"]
 * "John S." → ["john"] (single-char "s" dropped)
 */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export interface SelfSuggestion {
  id: number;
  name: string;
  reason: string;
}

/**
 * Suggest contacts that are likely self-accounts.
 *
 * For each contact NOT already flagged `isSelf`, check whether any of its name
 * tokens overlap the union of `userNameTokens` and `accountNameTokens`. If any
 * overlap exists, include the contact in the result with a human-readable reason
 * identifying the matched token set.
 *
 * @param contacts - All household contacts to evaluate.
 * @param userNameTokens - Tokens from the current user's displayName (>= 3 chars).
 * @param accountNameTokens - Tokens from all household account names (>= 3 chars).
 */
export function suggestSelfContacts(
  contacts: SuggestableContact[],
  userNameTokens: string[],
  accountNameTokens: string[],
): SelfSuggestion[] {
  const userSet = new Set(userNameTokens.filter((t) => t.length >= 3));
  const acctSet = new Set(accountNameTokens.filter((t) => t.length >= 3));

  const suggestions: SelfSuggestion[] = [];

  for (const contact of contacts) {
    // Already confirmed self — skip.
    if (contact.isSelf) continue;

    const nameTokens = tokenize(contact.name);

    const userMatches = nameTokens.filter((t) => userSet.has(t));
    const acctMatches = nameTokens.filter((t) => acctSet.has(t));

    if (userMatches.length > 0 && acctMatches.length > 0) {
      // Both name and account match — report both in the reason.
      suggestions.push({
        id: contact.id,
        name: contact.name,
        reason: `matches your name: ${userMatches.join(', ')}; matches account name: ${acctMatches.join(', ')}`,
      });
    } else if (userMatches.length > 0) {
      suggestions.push({
        id: contact.id,
        name: contact.name,
        reason: `matches your name: ${userMatches.join(', ')}`,
      });
    } else if (acctMatches.length > 0) {
      suggestions.push({
        id: contact.id,
        name: contact.name,
        reason: `matches account name: ${acctMatches.join(', ')}`,
      });
    }
  }

  return suggestions;
}
