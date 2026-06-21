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
  /** Money direction from the txn sign: negative amount = 'sent', positive = 'received'. */
  direction: 'sent' | 'received';
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

  // A 'sent' email belongs to an outgoing (negative) txn and a 'received' email
  // to an incoming (positive) one — otherwise a same-amount 'received $X from
  // Bob' email auto-attaches Bob to money the household SENT. Exception:
  // self-named emails, because one self e-transfer 'sent' email legitimately
  // describes both legs (the negative sending-account txn AND the positive
  // receiving-account txn).
  const directionCompatible = (e: InteracEmailLite, txnDirection: 'sent' | 'received') =>
    e.direction === txnDirection || normalizeContactName(e.name) === ownerKey;

  for (const t of txns) {
    // candidate emails: same amount, compatible direction, within the date window of THIS txn
    const cands = emails.filter(
      (e) =>
        e.amountCents === t.amountCents &&
        directionCompatible(e, t.direction) &&
        daysBetween(e.emailDate, t.date) <= WINDOW_DAYS,
    );
    if (cands.length === 0) continue;

    // best candidate = closest by date
    const best = cands.reduce((a, b) =>
      daysBetween(a.emailDate, t.date) <= daysBetween(b.emailDate, t.date) ? a : b,
    );

    // mutual uniqueness: how many txns does `best` plausibly match (same amount,
    // compatible direction, within window)?
    const bestTxns = txns.filter(
      (tt) =>
        tt.amountCents === best.amountCents &&
        directionCompatible(best, tt.direction) &&
        daysBetween(best.emailDate, tt.date) <= WINDOW_DAYS,
    );

    if (cands.length === 1 && bestTxns.length === 1) {
      auto.push(buildMatch(t.id, best));
    } else {
      review.push(buildMatch(t.id, best));
    }
  }

  return { auto, review };
}
