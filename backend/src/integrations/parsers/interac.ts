export type InteracDirection = 'sent' | 'received';
export interface ParsedInteracEmail {
  name: string;
  amountCents: number;
  direction: InteracDirection;
  ref: string | null;
}

const AMOUNT_RE = /\$\s?([\d,]+\.\d{2})/;
const REF_RE = /Reference\s*Number:?\s*([A-Za-z0-9]+)/i;
const SENT_SUBJECT_RE = /transfer to (.+?) (?:has been|was) successfully deposited/i;
const SENT_BODY_RE = /you sent to (.+?) (?:has been|was)/i;
// NOTE: the "received" form is UNVERIFIED — the prod probe captured only the
// "sent/deposited" form. This is best-effort; refine when a real received
// sample is available. The lookahead avoids truncating common names at a
// sentence period (still imperfect for abbreviation-prefixed names like "Dr.").
const RECEIVED_RE = /(?:received (?:an? interac e-?transfer )?from (.+?)(?=\s*[.,]|\s+has\b)|\b(.+?) sent you (?:money|an? interac))/i;

/** Collapse whitespace and fold an exact doubled token sequence
 *  ("FINNSKA INC. FINNSKA INC." -> "FINNSKA INC."). Casing preserved. */
function cleanName(raw: string): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  const words = t.split(' ');
  if (words.length >= 2 && words.length % 2 === 0) {
    const half = words.length / 2;
    const a = words.slice(0, half).join(' ');
    const b = words.slice(half).join(' ');
    if (a.toLowerCase() === b.toLowerCase()) return a;
  }
  return t;
}

export function parseInteracEmail(
  from: string,
  subject: string,
  body: string,
): ParsedInteracEmail | null {
  if (!/payments\.interac\.ca/i.test(from)) return null;
  const text = `${subject}\n${body}`;
  const amt = text.match(AMOUNT_RE);
  if (!amt) return null;
  const amountCents = Math.round(Number(amt[1].replace(/,/g, '')) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) return null;
  const ref = text.match(REF_RE)?.[1] ?? null;

  const sent = subject.match(SENT_SUBJECT_RE) ?? body.match(SENT_BODY_RE);
  if (sent?.[1]) return { name: cleanName(sent[1]), amountCents, direction: 'sent', ref };

  const recv = text.match(RECEIVED_RE);
  const recvName = recv?.[1] ?? recv?.[2];
  if (recvName) return { name: cleanName(recvName), amountCents, direction: 'received', ref };

  return null;
}
