/**
 * Sender-suggestion lifecycle for the discovery pass. Low-confidence discovery
 * hits cluster by sender into 'suggested' rows of receipt_sender_allowlist; the
 * user promotes (→ enabled, joins the fast scan) or dismisses (→ never
 * re-suggested, excluded from future discovery queries). No new table — these
 * are the same allowlist rows under a status discriminator.
 */
import { ReceiptSenderAllowlist } from '../models';

export interface SuggestionDTO {
  id: number;
  emailAddress: string;
  label: string | null;
  sampleSubject: string | null;
  candidateCount: number;
  lastSeenAt: string | null;
}

const EMAIL_RE = /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/;

/** Extract the bare lowercased address from a raw From header. */
export function parseEmailAddress(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const m = fromHeader.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

export async function upsertSenderSuggestion(args: {
  householdId: number;
  fromAddr: string | null;
  subject: string | null;
}): Promise<void> {
  const address = parseEmailAddress(args.fromAddr);
  if (!address) return;
  const existing = await ReceiptSenderAllowlist.findOne({
    where: { householdId: args.householdId, emailAddress: address },
  });
  if (!existing) {
    await ReceiptSenderAllowlist.create({
      householdId: args.householdId,
      emailAddress: address,
      status: 'suggested',
      source: 'discovery',
      enabled: false,
      sampleSubject: args.subject?.slice(0, 256) ?? null,
      candidateCount: 1,
      lastSeenAt: new Date(),
    });
    return;
  }
  // Only grow active suggestions; never touch enabled or dismissed rows.
  if (existing.status !== 'suggested') return;
  existing.set({
    candidateCount: existing.candidateCount + 1,
    sampleSubject: args.subject?.slice(0, 256) ?? existing.sampleSubject,
    lastSeenAt: new Date(),
  });
  await existing.save();
}

export async function listSenderSuggestions(householdId: number): Promise<SuggestionDTO[]> {
  const rows = await ReceiptSenderAllowlist.findAll({
    where: { householdId, status: 'suggested' },
    order: [
      ['candidate_count', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  return rows.map((r) => ({
    id: r.id,
    emailAddress: r.emailAddress,
    label: r.label,
    sampleSubject: r.sampleSubject,
    candidateCount: r.candidateCount,
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
  }));
}

async function flipSuggestion(
  householdId: number,
  id: number,
  next: 'enabled' | 'dismissed',
): Promise<boolean> {
  const row = await ReceiptSenderAllowlist.findOne({
    where: { id, householdId, status: 'suggested' },
  });
  if (!row) return false;
  row.set({ status: next, enabled: next === 'enabled' });
  await row.save();
  return true;
}

export function promoteSuggestion(args: { householdId: number; id: number }): Promise<boolean> {
  return flipSuggestion(args.householdId, args.id, 'enabled');
}

export function dismissSuggestion(args: { householdId: number; id: number }): Promise<boolean> {
  return flipSuggestion(args.householdId, args.id, 'dismissed');
}
