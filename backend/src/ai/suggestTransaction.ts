import type { Transaction as TxnModel } from '../models/Transaction';

import { sequelize } from '../models';
import { QueryTypes } from 'sequelize';
import { num } from '../util/numbers';
import { openaiJson } from './openaiJson';

export async function loadCategoryHints(): Promise<string[]> {
  const [a, b] = await Promise.all([
    sequelize.query<{ c: string }>(
      `SELECT DISTINCT TRIM(category) AS c FROM rules WHERE category IS NOT NULL AND TRIM(category) != ''`,
      { type: QueryTypes.SELECT },
    ),
    sequelize.query<{ c: string }>(
      `SELECT DISTINCT TRIM(final_category) AS c FROM transactions WHERE final_category IS NOT NULL AND TRIM(final_category) != ''`,
      { type: QueryTypes.SELECT },
    ),
  ]);
  const set = new Set<string>();
  for (const r of a) if (r.c) set.add(r.c);
  for (const r of b) if (r.c) set.add(r.c);
  return Array.from(set).sort((x, y) => x.localeCompare(y));
}

export type AiSuggestion = {
  category: string | null;
  business: boolean | null;
  splitType: 'me' | 'partner' | 'shared' | null;
  pctMe: number | null;
  pctPartner: number | null;
  notes: string | null;
  rationale: string | null;
};

function parseSuggestion(j: Record<string, unknown>): AiSuggestion {
  const category =
    typeof j.category === 'string' && j.category.trim()
      ? j.category.trim()
      : null;
  let business: boolean | null = null;
  if (typeof j.business === 'boolean') business = j.business;
  else if (j.business === 'true') business = true;
  else if (j.business === 'false') business = false;

  let splitType: AiSuggestion['splitType'] = null;
  if (j.splitType === 'me' || j.splitType === 'partner' || j.splitType === 'shared') {
    splitType = j.splitType;
  }

  const pctMe =
    typeof j.pctMe === 'number' && Number.isFinite(j.pctMe)
      ? j.pctMe
      : typeof j.pctMe === 'string' && j.pctMe.trim()
        ? Number(j.pctMe)
        : null;
  const pctPartner =
    typeof j.pctPartner === 'number' && Number.isFinite(j.pctPartner)
      ? j.pctPartner
      : typeof j.pctPartner === 'string' && j.pctPartner.trim()
        ? Number(j.pctPartner)
        : null;

  const notes =
    typeof j.notes === 'string' && j.notes.trim() ? j.notes.trim() : null;
  const rationale =
    typeof j.rationale === 'string' && j.rationale.trim()
      ? j.rationale.trim()
      : null;

  return {
    category,
    business,
    splitType,
    pctMe: pctMe != null && Number.isFinite(pctMe) ? pctMe : null,
    pctPartner:
      pctPartner != null && Number.isFinite(pctPartner) ? pctPartner : null,
    notes,
    rationale,
  };
}

export async function suggestTransactionFields(
  txn: TxnModel,
  hints: string[],
): Promise<AiSuggestion> {
  const categories = hints.length ? hints.join(', ') : '(none yet — invent short labels)';

  const user = [
    `Categorize this card transaction for a household expense tracker.`,
    ``,
    `Date: ${txn.date}`,
    `Merchant (clean): ${txn.merchantClean}`,
    `Merchant (raw): ${txn.merchantRaw}`,
    `Amount: ${num(txn.amount)} ${txn.currency}`,
    `Current auto category: ${txn.autoCategory ?? 'null'}`,
    `Current final category: ${txn.finalCategory ?? 'null'}`,
    `Notes: ${txn.notes ?? ''}`,
    ``,
    `Known category labels already used in this database (prefer reusing when it fits): ${categories}`,
    ``,
    `Return ONLY a JSON object with keys: category (string or null), business (boolean), splitType ("me"|"partner"|"shared"), pctMe (number 0-1 or null), pctPartner (number 0-1 or null), notes (string or null), rationale (one short sentence).`,
    `For typical personal spending, business is usually false. Use split "shared" with pctMe 0.5 only when it is clearly shared household spend.`,
  ].join('\n');

  const j = await openaiJson([
    {
      role: 'system',
      content:
        'You output compact JSON only. Be practical with merchant names; map cafes to Groceries or Dining as appropriate.',
    },
    { role: 'user', content: user },
  ]);

  return parseSuggestion(j);
}

