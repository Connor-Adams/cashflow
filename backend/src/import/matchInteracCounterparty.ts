import { normalizeContactName } from '../contacts/normalizeContactName.js';

export interface InteracEmailLite {
  name: string;
  amountCents: number;
  direction: 'sent' | 'received';
  ref: string | null;
  emailDate: string; // YYYY-MM-DD
  messageId: string;
}
export interface NamelessTxnLite {
  id: number;
  amountCents: number; // absolute value
  date: string; // YYYY-MM-DD
}
export interface InteracMatch {
  txnId: number;
  name: string;
  ref: string | null;
  messageId: string;
  isSelf: boolean;
}
export interface InteracMatchResult {
  auto: InteracMatch[];
  review: InteracMatch[];
}

const WINDOW_DAYS = 3;
const daysBetween = (a: string, b: string) =>
  Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

export function matchInteracCounterparty(
  emails: InteracEmailLite[],
  txns: NamelessTxnLite[],
  ownerName: string,
): InteracMatchResult {
  const ownerKey = normalizeContactName(ownerName);
  const auto: InteracMatch[] = [];
  const review: InteracMatch[] = [];

  const buildMatch = (txnId: number, e: InteracEmailLite): InteracMatch => ({
    txnId,
    name: e.name,
    ref: e.ref,
    messageId: e.messageId,
    isSelf: normalizeContactName(e.name) === ownerKey,
  });

  for (const t of txns) {
    // candidate emails: same amount, within the date window of THIS txn
    const cands = emails.filter(
      (e) => e.amountCents === t.amountCents && daysBetween(e.emailDate, t.date) <= WINDOW_DAYS,
    );
    if (cands.length === 0) continue;

    // best candidate = closest by date
    const best = cands.reduce((a, b) =>
      daysBetween(a.emailDate, t.date) <= daysBetween(b.emailDate, t.date) ? a : b,
    );

    // mutual uniqueness: how many txns does `best` plausibly match (same amount, within window)?
    const bestTxns = txns.filter(
      (tt) => tt.amountCents === best.amountCents && daysBetween(best.emailDate, tt.date) <= WINDOW_DAYS,
    );

    if (cands.length === 1 && bestTxns.length === 1) {
      auto.push(buildMatch(t.id, best));
    } else {
      review.push(buildMatch(t.id, best));
    }
  }

  return { auto, review };
}
