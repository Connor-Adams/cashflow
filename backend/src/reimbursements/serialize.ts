/**
 * Pure helpers for the reimbursement tracker (issue #216): input validation,
 * effective-status derivation, serialization, and dashboard summarization.
 *
 * Everything here is a pure function so it can be unit-tested without a DB.
 * Route handlers (routes/reimbursements.ts) are thin wrappers that load
 * Sequelize rows and feed them through these helpers.
 */
import {
  REIMBURSEMENT_STATUSES,
  type Reimbursement,
  type ReimbursementStatus,
} from '../models/Reimbursement';

// ---------- Date helpers ----------

/** ISO YYYY-MM-DD for a Date, using UTC components so timezone drift can't
 *  shift the date the user typed. */
export function isoDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Today's UTC date as YYYY-MM-DD. */
export function todayIso(now: Date = new Date()): string {
  return isoDate(now);
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a value that should be an ISO date (or null/empty → null).
 * Returns `undefined` to signal an invalid value the caller should reject.
 */
export function parseIsoOrNull(raw: unknown): string | null | undefined {
  if (raw == null || raw === '') return null;
  const s = String(raw).slice(0, 10);
  if (!ISO_DATE_RE.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return undefined;
  // Reject impossible dates like 2026-02-31 that Date silently rolls over.
  if (isoDate(d) !== s) return undefined;
  return s;
}

/**
 * Resolve a client-supplied `today` query param (a YYYY-MM-DD string built
 * from the browser's *local* date) to the reference date for overdue
 * derivation, falling back to the server's UTC today. Without the override,
 * claims flip overdue at UTC midnight — hours early for behind-UTC users.
 * Non-string / invalid values fall back silently, mirroring how the list
 * route treats malformed dueDateFrom/To.
 */
export function resolveToday(raw: unknown): string {
  if (typeof raw !== 'string') return todayIso();
  return parseIsoOrNull(raw) ?? todayIso();
}

/** Days from `today` until `dueDate`. Negative when overdue, null when no
 *  due date. */
export function daysUntilDue(
  dueDate: string | null | undefined,
  today: string = todayIso(),
): number | null {
  if (!dueDate) return null;
  const a = new Date(`${today}T00:00:00Z`).getTime();
  const b = new Date(`${dueDate}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

// ---------- Amount helpers ----------

/**
 * Normalize a money input to a fixed-4-decimal string (matching DECIMAL(14,4)).
 * Returns undefined for non-finite / non-positive amounts (a reimbursement of
 * 0 or negative makes no sense). Accepts numbers or numeric strings.
 */
export function normalizeAmount(raw: unknown): string | undefined {
  if (raw == null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n.toFixed(4);
}

/** Absolute value of a (possibly string) transaction amount as a positive
 *  fixed-4 string; used to default a claim amount from an outlay. */
export function absAmount(raw: unknown): string {
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isFinite(n)) return '0.0000';
  return Math.abs(n).toFixed(4);
}

function normalizeCurrency(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) return undefined;
  return s;
}

// ---------- Effective status (overdue derivation) ----------

/**
 * True iff a claim is effectively overdue: still open (`expected`) with a due
 * date strictly before today. Derived so no cron is needed to flip statuses.
 */
export function isOverdue(
  r: Pick<Reimbursement, 'status' | 'dueDate'>,
  today: string = todayIso(),
): boolean {
  if (r.status !== 'expected') return false;
  if (!r.dueDate) return false;
  return r.dueDate < today;
}

/**
 * The status to display: the stored status, except an `expected` claim past
 * its due date surfaces as `overdue`. `received` / `waived` / explicitly-pinned
 * `overdue` pass through unchanged.
 */
export function computeEffectiveStatus(
  r: Pick<Reimbursement, 'status' | 'dueDate'>,
  today: string = todayIso(),
): ReimbursementStatus {
  if (isOverdue(r, today)) return 'overdue';
  return r.status;
}

// ---------- Validation ----------

export interface MarkReimbursableInput {
  amount?: string;
  currency?: string;
  contactId?: number | null;
  partyName?: string | null;
  dueDate?: string | null;
  notes?: string | null;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

/**
 * Validate the body of POST /transactions/:id/reimbursable. `txnAmount` /
 * `txnCurrency` provide defaults from the source transaction so the caller can
 * "mark reimbursable" with no body. At least one party (contactId or partyName)
 * must be present once defaults are applied.
 */
export function validateMarkReimbursable(
  raw: Record<string, unknown>,
  defaults: { txnAmount: unknown; txnCurrency: unknown },
): ValidationResult<Required<Pick<MarkReimbursableInput, 'amount' | 'currency'>> &
  MarkReimbursableInput> {
  const out: MarkReimbursableInput = {};

  // Amount: explicit wins, else default to abs(txn.amount).
  if ('amount' in raw && raw.amount != null && raw.amount !== '') {
    const amt = normalizeAmount(raw.amount);
    if (amt === undefined) {
      return { ok: false, status: 400, error: 'amount must be a positive number' };
    }
    out.amount = amt;
  } else {
    out.amount = absAmount(defaults.txnAmount);
    if (out.amount === '0.0000') {
      return {
        ok: false,
        status: 400,
        error: 'amount is required (source transaction has no amount)',
      };
    }
  }

  // Currency: explicit wins, else default to txn.currency.
  if ('currency' in raw && raw.currency != null && raw.currency !== '') {
    const cur = normalizeCurrency(raw.currency);
    if (cur === undefined) {
      return { ok: false, status: 400, error: 'currency must be a 3-letter code' };
    }
    out.currency = cur;
  } else {
    const cur = normalizeCurrency(defaults.txnCurrency);
    if (cur === undefined) {
      return { ok: false, status: 400, error: 'currency is required' };
    }
    out.currency = cur;
  }

  const party = validateParty(raw);
  if (!party.ok) return party;
  out.contactId = party.value.contactId;
  out.partyName = party.value.partyName;

  if ('dueDate' in raw) {
    const due = parseIsoOrNull(raw.dueDate);
    if (due === undefined) {
      return { ok: false, status: 400, error: 'dueDate must be ISO YYYY-MM-DD or null' };
    }
    out.dueDate = due;
  }

  if ('notes' in raw) {
    out.notes = raw.notes == null ? null : String(raw.notes).slice(0, 4000);
  }

  return {
    ok: true,
    value: out as Required<Pick<MarkReimbursableInput, 'amount' | 'currency'>> &
      MarkReimbursableInput,
  };
}

function validateParty(
  raw: Record<string, unknown>,
): ValidationResult<{ contactId: number | null; partyName: string | null }> {
  let contactId: number | null = null;
  let partyName: string | null = null;

  if ('contactId' in raw && raw.contactId != null && raw.contactId !== '') {
    const n = Number(raw.contactId);
    if (!Number.isInteger(n) || n <= 0) {
      return { ok: false, status: 400, error: 'contactId must be a positive integer' };
    }
    contactId = n;
  }
  if ('partyName' in raw && raw.partyName != null && raw.partyName !== '') {
    partyName = String(raw.partyName).trim().slice(0, 160);
    if (partyName.length === 0) partyName = null;
  }
  if (contactId == null && !partyName) {
    return {
      ok: false,
      status: 400,
      error: 'a party is required: provide contactId or partyName',
    };
  }
  return { ok: true, value: { contactId, partyName } };
}

export interface ReimbursementPatch {
  amount?: string;
  currency?: string;
  contactId?: number | null;
  partyName?: string | null;
  dueDate?: string | null;
  status?: ReimbursementStatus;
  notes?: string | null;
}

/**
 * Validate the body of PUT /reimbursements/:id. Every field is optional; only
 * the keys present in `raw` are returned. Party fields are validated together
 * only when at least one is supplied, and may not BOTH be cleared (a claim
 * must always retain a party).
 */
export function validateReimbursementPatch(
  raw: Record<string, unknown>,
): ValidationResult<ReimbursementPatch> {
  const out: ReimbursementPatch = {};

  if ('amount' in raw) {
    const amt = normalizeAmount(raw.amount);
    if (amt === undefined) {
      return { ok: false, status: 400, error: 'amount must be a positive number' };
    }
    out.amount = amt;
  }
  if ('currency' in raw) {
    const cur = normalizeCurrency(raw.currency);
    if (cur === undefined) {
      return { ok: false, status: 400, error: 'currency must be a 3-letter code' };
    }
    out.currency = cur;
  }
  if ('contactId' in raw) {
    if (raw.contactId == null || raw.contactId === '') {
      out.contactId = null;
    } else {
      const n = Number(raw.contactId);
      if (!Number.isInteger(n) || n <= 0) {
        return { ok: false, status: 400, error: 'contactId must be a positive integer' };
      }
      out.contactId = n;
    }
  }
  if ('partyName' in raw) {
    if (raw.partyName == null || raw.partyName === '') {
      out.partyName = null;
    } else {
      const s = String(raw.partyName).trim().slice(0, 160);
      out.partyName = s.length ? s : null;
    }
  }
  // Guard: if the patch clears both party fields, reject — a claim must keep
  // at least one party. (Only enforce when BOTH are explicitly set to empty;
  // a partial patch that clears one is fine because the other may remain.)
  if (
    'contactId' in out &&
    out.contactId == null &&
    'partyName' in out &&
    out.partyName == null
  ) {
    return {
      ok: false,
      status: 400,
      error: 'a party is required: cannot clear both contactId and partyName',
    };
  }
  if ('dueDate' in raw) {
    const due = parseIsoOrNull(raw.dueDate);
    if (due === undefined) {
      return { ok: false, status: 400, error: 'dueDate must be ISO YYYY-MM-DD or null' };
    }
    out.dueDate = due;
  }
  if ('status' in raw) {
    const v = String(raw.status ?? '');
    if (!(REIMBURSEMENT_STATUSES as readonly string[]).includes(v)) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${REIMBURSEMENT_STATUSES.join(', ')}`,
      };
    }
    out.status = v as ReimbursementStatus;
  }
  if ('notes' in raw) {
    out.notes = raw.notes == null ? null : String(raw.notes).slice(0, 4000);
  }
  return { ok: true, value: out };
}

// ---------- Serialization ----------

export interface ReimbursementContactView {
  id: number;
  name: string;
}

export interface ReimbursementTransactionView {
  id: number;
  date: string;
  merchant: string | null;
  amount: string;
  currency: string;
}

export interface ReimbursementView {
  id: number;
  householdId: number;
  transactionId: number;
  contactId: number | null;
  partyName: string | null;
  /** Best display label for the party (contact name if available). */
  partyLabel: string;
  amount: string;
  currency: string;
  dueDate: string | null;
  status: ReimbursementStatus;
  effectiveStatus: ReimbursementStatus;
  isOverdue: boolean;
  daysUntilDue: number | null;
  repaymentTransactionId: number | null;
  receivedAt: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  contact?: ReimbursementContactView | null;
  transaction?: ReimbursementTransactionView | null;
  repaymentTransaction?: ReimbursementTransactionView | null;
}

// Loosely-typed row so the serializer accepts an eager-loaded instance with
// optional included associations without fighting Sequelize's inferred types.
export interface ReimbursementRow {
  id: number;
  householdId: number;
  transactionId: number;
  contactId: number | null;
  partyName: string | null;
  amount: string | number;
  currency: string;
  dueDate: string | null;
  status: ReimbursementStatus;
  repaymentTransactionId: number | null;
  receivedAt: Date | string | null;
  notes: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  contact?: { id: number; name: string } | null;
  transaction?: {
    id: number;
    date: string;
    merchantClean?: string | null;
    merchant?: string | null;
    amount: string | number;
    currency: string;
  } | null;
  repaymentTransaction?: {
    id: number;
    date: string;
    merchantClean?: string | null;
    merchant?: string | null;
    amount: string | number;
    currency: string;
  } | null;
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function txnView(
  t: ReimbursementRow['transaction'] | ReimbursementRow['repaymentTransaction'],
): ReimbursementTransactionView | null {
  if (!t) return null;
  return {
    id: t.id,
    date: t.date,
    merchant: t.merchantClean ?? t.merchant ?? null,
    amount: String(t.amount),
    currency: t.currency,
  };
}

export function serializeReimbursement(
  r: ReimbursementRow,
  today: string = todayIso(),
): ReimbursementView {
  const effectiveStatus = computeEffectiveStatus(r, today);
  const partyLabel = r.contact?.name ?? r.partyName ?? 'Unknown party';
  return {
    id: r.id,
    householdId: r.householdId,
    transactionId: r.transactionId,
    contactId: r.contactId,
    partyName: r.partyName,
    partyLabel,
    amount: String(r.amount),
    currency: r.currency,
    dueDate: r.dueDate,
    status: r.status,
    effectiveStatus,
    isOverdue: isOverdue(r, today),
    daysUntilDue: daysUntilDue(r.dueDate, today),
    repaymentTransactionId: r.repaymentTransactionId,
    receivedAt: toIsoOrNull(r.receivedAt),
    notes: r.notes,
    createdAt: toIsoOrNull(r.createdAt),
    updatedAt: toIsoOrNull(r.updatedAt),
    contact: r.contact ? { id: r.contact.id, name: r.contact.name } : null,
    transaction: txnView(r.transaction),
    repaymentTransaction: txnView(r.repaymentTransaction),
  };
}

// ---------- Dashboard summary ----------

export interface SummaryGroup {
  /** Stable key for the group: `contact:<id>` or `name:<lowercased>`. */
  key: string;
  partyLabel: string;
  contactId: number | null;
  currency: string;
  /** Total still outstanding (expected + overdue) in this party+currency. */
  outstanding: string;
  /** Total already received in this party+currency. */
  received: string;
  /** Counts by effective status. */
  counts: {
    expected: number;
    overdue: number;
    received: number;
    waived: number;
    total: number;
  };
}

export interface ReimbursementSummary {
  /** One row per (party, currency). Sorted by outstanding desc. */
  groups: SummaryGroup[];
  /** Outstanding totals keyed by currency across all parties. */
  outstandingByCurrency: Record<string, string>;
  /** Count of effectively-overdue claims across all parties. */
  overdueCount: number;
  totalCount: number;
}

function addMoney(a: string, b: string): string {
  // 4-decimal fixed-point add via integer math to avoid float drift.
  const toCents = (s: string) => Math.round(Number(s) * 10_000);
  return ((toCents(a) + toCents(b)) / 10_000).toFixed(4);
}

/**
 * Amount to credit toward "received" for a received claim. Linking a repayment
 * marks the FULL claim received regardless of the repayment's size (the
 * matcher tolerates a 25% mismatch), so when a same-currency repayment
 * transaction is hydrated, credit only the actual inflow — capped at the claim
 * amount — instead of the claim face value. Cross-currency or missing
 * repayments (manual marks) fall back to the face value.
 */
function receivedCredit(r: ReimbursementRow): string {
  const face = String(r.amount);
  const rt = r.repaymentTransaction;
  if (!rt || rt.currency !== r.currency) return face;
  const inflow = Number(rt.amount);
  if (!Number.isFinite(inflow) || inflow <= 0) return face;
  return Math.min(Number(face), inflow).toFixed(4);
}

// ---------- Per-Contact open-claims aggregate (#374) ----------

export interface ContactOpenReimbursements {
  /** Number of effectively-open claims (expected or derived-overdue). */
  count: number;
  /** Outstanding amount per currency as fixed-4 strings. */
  byCurrency: Record<string, string>;
  /** The open claim rows themselves, fully serialized. */
  items: ReimbursementView[];
}

/**
 * #374 — given a contact's reimbursement rows (already loaded with the
 * INCLUDE shape the routes use), summarize the **open** ones. Drives the
 * "Open reimbursements: $X across Y items" counter and per-item list on the
 * contact detail UI. Received and waived claims are excluded.
 */
export function summarizeOpenForContact(
  rows: ReimbursementRow[],
  today: string = todayIso(),
): ContactOpenReimbursements {
  const items: ReimbursementView[] = [];
  const byCurrency: Record<string, string> = {};
  for (const r of rows) {
    const eff = computeEffectiveStatus(r, today);
    if (eff !== 'expected' && eff !== 'overdue') continue;
    const view = serializeReimbursement(r, today);
    items.push(view);
    byCurrency[view.currency] = addMoney(
      byCurrency[view.currency] ?? '0.0000',
      String(view.amount),
    );
  }
  return { count: items.length, byCurrency, items };
}

/**
 * Group outstanding + received reimbursements by (party, currency) for the
 * dashboard. `party` keys on contactId when present, else the lowercased
 * free-text name, so two claims to the same Contact (or same typed name) in
 * the same currency roll up together.
 */
export function summarize(
  rows: ReimbursementRow[],
  today: string = todayIso(),
): ReimbursementSummary {
  const groups = new Map<string, SummaryGroup>();
  const outstandingByCurrency: Record<string, string> = {};
  let overdueCount = 0;

  for (const r of rows) {
    const eff = computeEffectiveStatus(r, today);
    const partyKey =
      r.contactId != null
        ? `contact:${r.contactId}`
        : `name:${(r.partyName ?? '').trim().toLowerCase()}`;
    const groupKey = `${partyKey}|${r.currency}`;
    let g = groups.get(groupKey);
    if (!g) {
      g = {
        key: groupKey,
        partyLabel: r.contact?.name ?? r.partyName ?? 'Unknown party',
        contactId: r.contactId,
        currency: r.currency,
        outstanding: '0.0000',
        received: '0.0000',
        counts: { expected: 0, overdue: 0, received: 0, waived: 0, total: 0 },
      };
      groups.set(groupKey, g);
    }
    g.counts.total += 1;
    g.counts[eff] += 1;

    const amt = String(r.amount);
    if (eff === 'expected' || eff === 'overdue') {
      g.outstanding = addMoney(g.outstanding, amt);
      outstandingByCurrency[r.currency] = addMoney(
        outstandingByCurrency[r.currency] ?? '0.0000',
        amt,
      );
    } else if (eff === 'received') {
      g.received = addMoney(g.received, receivedCredit(r));
    }
    if (eff === 'overdue') overdueCount += 1;
  }

  const sorted = [...groups.values()].sort(
    (a, b) => Number(b.outstanding) - Number(a.outstanding),
  );

  return {
    groups: sorted,
    outstandingByCurrency,
    overdueCount,
    totalCount: rows.length,
  };
}
