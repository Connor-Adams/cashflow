import { Router, type Request } from 'express';
import { Op } from 'sequelize';
import { Account, LiabilityAccount, PlannedEvent, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { currentOwed, utilizationPct } from '../cards/utilization';
import { computeSafeToSpend, type SafeToSpendResult } from '../cashflow/safeToSpend';

/**
 * Credit-card payment planner (#243). OPERATIONAL bill management for
 * credit_card accounts — distinct from /api/debt (which is payoff *strategy*:
 * avalanche/snowball/interest saved). This route plans the next statement
 * payment: it distinguishes current vs statement vs minimum balance, warns on
 * upcoming due dates, tracks autopay, materializes a planned payment into the
 * cashflow forecast, and lets the user mark a payment paid / link it to a real
 * transaction.
 *
 * Metadata is stored on the shared `liability_accounts` sidecar (#202), which
 * already holds statement_balance / minimum_payment / due_day; #243 added the
 * operational columns (statement_date, autopay_*, payment_account_id).
 */
const router = Router();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CREDIT_CARD_TYPE = 'credit_card';
const AUTOPAY_TYPES = new Set(['full', 'minimum', 'fixed']);
const PAYMENT_STRATEGIES = new Set(['statement', 'minimum', 'current']);
// A payment due within this many days is flagged for the UI warning state.
const DUE_SOON_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseAsOf(req: Request): string {
  // Accept asOfDate from the query string (GET) or the body (POST). A valid
  // YYYY-MM-DD wins; otherwise default to today.
  const candidates = [req.query?.asOfDate, (req.body as Record<string, unknown> | undefined)?.asOfDate];
  for (const raw of candidates) {
    if (raw != null && raw !== '' && ISO_DATE_RE.test(String(raw))) {
      return String(raw);
    }
  }
  return todayIso();
}

function ymd(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = iso.split('-').map((p) => parseInt(p, 10));
  return { y, m, d };
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = ymd(fromIso);
  const b = ymd(toIso);
  const f = Date.UTC(a.y, a.m - 1, a.d);
  const t = Date.UTC(b.y, b.m - 1, b.d);
  return Math.round((t - f) / MS_PER_DAY);
}

/**
 * Given a day-of-month (1-31) and a reference date, return the next calendar
 * date (>= asOf) that falls on that day. Clamps to the last day of the month
 * for short months (e.g. dueDay=31 in February → the 28th/29th). Exported for
 * unit testing.
 */
export function nextDueDate(dueDay: number, asOfIso: string): string {
  const { y, m, d } = ymd(asOfIso);
  // Try this month first, then the next, clamping to month length.
  for (let offset = 0; offset < 2; offset += 1) {
    const year = m - 1 + offset >= 12 ? y + 1 : y;
    const monthIndex = (m - 1 + offset) % 12;
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const day = Math.min(dueDay, lastDay);
    const candidate = `${year.toString().padStart(4, '0')}-${(monthIndex + 1)
      .toString()
      .padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    if (offset === 0 && day < d) continue; // already past this month's due day
    return candidate;
  }
  // Unreachable given the loop above, but satisfy the type checker.
  return asOfIso;
}

type CardRow = {
  accountId: number;
  name: string;
  accountType: string;
  currency: string;
  /** Transaction-derived amount currently owed, as a positive number. */
  currentBalance: number;
  /** User-entered statement snapshot, or null. */
  statementBalance: number | null;
  minimumPayment: number;
  dueDay: number | null;
  statementDate: string | null;
  autopayEnabled: boolean;
  autopayType: string | null;
  autopayAmount: number | null;
  paymentAccountId: number | null;
  /** User-entered credit limit, or null. Positive number when set. */
  creditLimit: number | null;
  /** currentBalance / creditLimit × 100, or null when either is missing. */
  utilizationPct: number | null;
  /** Next calendar due date derived from dueDay relative to asOf, or null. */
  nextDueDate: string | null;
  /** Whole days until nextDueDate (>= 0), or null when no dueDay set. */
  daysUntilDue: number | null;
  /** True when a payment is due within DUE_SOON_DAYS. */
  dueSoon: boolean;
};

/** Assemble the household's credit cards joined with their liability profiles. */
async function loadCards(req: Request, asOf: string): Promise<CardRow[]> {
  const accounts = await Account.findAll({
    where: { ...householdWhere(req), accountType: CREDIT_CARD_TYPE },
    order: [['id', 'ASC']],
  });
  if (accounts.length === 0) return [];

  const profiles = await LiabilityAccount.findAll({
    where: { accountId: { [Op.in]: accounts.map((a) => a.id) } },
  });
  const profileByAccount = new Map<number, InstanceType<typeof LiabilityAccount>>();
  for (const p of profiles) profileByAccount.set(p.accountId, p);

  const rows: CardRow[] = [];
  for (const account of accounts) {
    const profile = profileByAccount.get(account.id) ?? null;
    const currentBalance = await currentOwed(account, asOf);
    const dueDay = profile ? profile.dueDay : null;
    const due = dueDay != null ? nextDueDate(dueDay, asOf) : null;
    const daysUntilDue = due != null ? daysBetween(asOf, due) : null;
    const creditLimit =
      profile && profile.creditLimit != null ? Number(profile.creditLimit) : null;
    // Closed cards are dimmed in the UI and don't carry meaningful utilization;
    // suppress the pct so the badge logic on the frontend just hides itself.
    const isClosed = Boolean(account.closedAt && account.closedAt <= asOf);
    rows.push({
      accountId: account.id,
      name: account.name,
      accountType: account.accountType,
      currency: account.defaultCurrency ?? 'CAD',
      currentBalance,
      statementBalance:
        profile && profile.statementBalance != null ? Number(profile.statementBalance) : null,
      minimumPayment: profile ? Number(profile.minimumPayment) : 0,
      dueDay,
      statementDate: profile ? profile.statementDate : null,
      autopayEnabled: profile ? profile.autopayEnabled : false,
      autopayType: profile ? profile.autopayType : null,
      autopayAmount: profile && profile.autopayAmount != null ? Number(profile.autopayAmount) : null,
      paymentAccountId: profile ? profile.paymentAccountId : null,
      creditLimit,
      utilizationPct: isClosed ? null : utilizationPct(currentBalance, creditLimit),
      nextDueDate: due,
      daysUntilDue,
      dueSoon: daysUntilDue != null && daysUntilDue >= 0 && daysUntilDue <= DUE_SOON_DAYS,
    });
  }
  return rows;
}

function serializeCard(row: CardRow): CardRow {
  return row;
}

// ---------------------------------------------------------------------------
// GET /api/credit-cards — list cards with balances + due-date warnings
// ---------------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const asOf = parseAsOf(req);
    const cards = await loadCards(req, asOf);
    const currency = cards[0]?.currency ?? 'CAD';
    res.json({ currency, asOfDate: asOf, cards: cards.map(serializeCard) });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/credit-cards/:accountId — upsert the card's payment metadata
// ---------------------------------------------------------------------------

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

type CardProfileInput = {
  statementBalance: number | null;
  minimumPayment: number;
  dueDay: number | null;
  statementDate: string | null;
  autopayEnabled: boolean;
  autopayType: string | null;
  autopayAmount: number | null;
  paymentAccountId: number | null;
  creditLimit: number | null;
};

function validateCardProfileInput(
  raw: Record<string, unknown>,
  existing: InstanceType<typeof LiabilityAccount> | null,
): ValidationResult<CardProfileInput> {
  // Each field is optional on PUT; unspecified fields keep the existing value
  // (or the model default for a fresh row).
  const def = {
    statementBalance: existing && existing.statementBalance != null ? Number(existing.statementBalance) : null,
    minimumPayment: existing ? Number(existing.minimumPayment) : 0,
    dueDay: existing ? existing.dueDay : null,
    statementDate: existing ? existing.statementDate : null,
    autopayEnabled: existing ? existing.autopayEnabled : false,
    autopayType: existing ? existing.autopayType : null,
    autopayAmount: existing && existing.autopayAmount != null ? Number(existing.autopayAmount) : null,
    paymentAccountId: existing ? existing.paymentAccountId : null,
    creditLimit: existing && existing.creditLimit != null ? Number(existing.creditLimit) : null,
  };

  let statementBalance = def.statementBalance;
  if ('statementBalance' in raw) {
    if (raw.statementBalance == null || raw.statementBalance === '') {
      statementBalance = null;
    } else {
      const n = Number(raw.statementBalance);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, status: 400, error: 'statementBalance must be a non-negative number' };
      }
      statementBalance = n;
    }
  }

  let minimumPayment = def.minimumPayment;
  if ('minimumPayment' in raw && raw.minimumPayment !== undefined) {
    const n = Number(raw.minimumPayment);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, status: 400, error: 'minimumPayment must be a non-negative number' };
    }
    minimumPayment = n;
  }

  let dueDay = def.dueDay;
  if ('dueDay' in raw) {
    if (raw.dueDay == null || raw.dueDay === '') {
      dueDay = null;
    } else {
      const n = Number(raw.dueDay);
      if (!Number.isInteger(n) || n < 1 || n > 31) {
        return { ok: false, status: 400, error: 'dueDay must be an integer between 1 and 31' };
      }
      dueDay = n;
    }
  }

  let statementDate = def.statementDate;
  if ('statementDate' in raw) {
    if (raw.statementDate == null || raw.statementDate === '') {
      statementDate = null;
    } else {
      const s = String(raw.statementDate);
      if (!ISO_DATE_RE.test(s)) {
        return { ok: false, status: 400, error: 'statementDate must be YYYY-MM-DD' };
      }
      statementDate = s;
    }
  }

  let autopayEnabled = def.autopayEnabled;
  if ('autopayEnabled' in raw && raw.autopayEnabled !== undefined) {
    autopayEnabled = raw.autopayEnabled === true || raw.autopayEnabled === 'true';
  }

  let autopayType = def.autopayType;
  if ('autopayType' in raw) {
    if (raw.autopayType == null || raw.autopayType === '') {
      autopayType = null;
    } else {
      const t = String(raw.autopayType);
      if (!AUTOPAY_TYPES.has(t)) {
        return {
          ok: false,
          status: 400,
          error: `autopayType must be one of: ${Array.from(AUTOPAY_TYPES).join(', ')}`,
        };
      }
      autopayType = t;
    }
  }

  let autopayAmount = def.autopayAmount;
  if ('autopayAmount' in raw) {
    if (raw.autopayAmount == null || raw.autopayAmount === '') {
      autopayAmount = null;
    } else {
      const n = Number(raw.autopayAmount);
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, status: 400, error: 'autopayAmount must be a non-negative number' };
      }
      autopayAmount = n;
    }
  }

  let paymentAccountId = def.paymentAccountId;
  if ('paymentAccountId' in raw) {
    if (raw.paymentAccountId == null || raw.paymentAccountId === '') {
      paymentAccountId = null;
    } else {
      const n = Number(raw.paymentAccountId);
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, status: 400, error: 'paymentAccountId must be a positive integer or null' };
      }
      paymentAccountId = n;
    }
  }

  // When autopay is turned off, clear the dependent fields so we never report
  // a stale "minimum autopay of $X" on a card with autopay disabled.
  if (!autopayEnabled) {
    autopayType = null;
    autopayAmount = null;
  }

  let creditLimit = def.creditLimit;
  if ('creditLimit' in raw) {
    if (raw.creditLimit == null || raw.creditLimit === '') {
      creditLimit = null;
    } else {
      const n = Number(raw.creditLimit);
      if (!Number.isFinite(n) || n <= 0) {
        return { ok: false, status: 400, error: 'creditLimit must be greater than 0 or null' };
      }
      creditLimit = n;
    }
  }

  return {
    ok: true,
    value: {
      statementBalance,
      minimumPayment,
      dueDay,
      statementDate,
      autopayEnabled,
      autopayType,
      autopayAmount,
      paymentAccountId,
      creditLimit,
    },
  };
}

type CardProfileResponse = {
  accountId: number;
  statementBalance: number | null;
  minimumPayment: number;
  dueDay: number | null;
  statementDate: string | null;
  autopayEnabled: boolean;
  autopayType: string | null;
  autopayAmount: number | null;
  paymentAccountId: number | null;
  creditLimit: number | null;
};

function serializeProfile(row: InstanceType<typeof LiabilityAccount>): CardProfileResponse {
  return {
    accountId: row.accountId,
    statementBalance: row.statementBalance != null ? Number(row.statementBalance) : null,
    minimumPayment: Number(row.minimumPayment),
    dueDay: row.dueDay,
    statementDate: row.statementDate,
    autopayEnabled: row.autopayEnabled,
    autopayType: row.autopayType,
    autopayAmount: row.autopayAmount != null ? Number(row.autopayAmount) : null,
    paymentAccountId: row.paymentAccountId,
    creditLimit: row.creditLimit != null ? Number(row.creditLimit) : null,
  };
}

/** Resolve a credit-card account in the caller's household, or send an error. */
async function requireCardAccount(
  req: Request,
  res: import('express').Response,
  accountId: number,
): Promise<InstanceType<typeof Account> | null> {
  const account = await Account.findOne({ where: { id: accountId, ...householdWhere(req) } });
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }
  if (account.accountType !== CREDIT_CARD_TYPE) {
    res.status(400).json({ error: 'account_type must be credit_card' });
    return null;
  }
  return account;
}

router.put('/:accountId', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const accountId = parseInt(req.params.accountId, 10);
    if (!Number.isInteger(accountId) || accountId < 1) {
      res.status(400).json({ error: 'Invalid accountId' });
      return;
    }

    const account = await requireCardAccount(req, res, accountId);
    if (!account) return;

    const existing = await LiabilityAccount.findOne({ where: { accountId } });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateCardProfileInput(body, existing);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    const v = result.value;

    // A funding account, if supplied, must belong to the same household.
    if (v.paymentAccountId != null) {
      const funding = await Account.findOne({
        where: { id: v.paymentAccountId, ...householdWhere(req) },
        attributes: ['id'],
      });
      if (!funding) {
        res.status(400).json({ error: 'paymentAccountId must reference an account in your household' });
        return;
      }
    }

    let row: InstanceType<typeof LiabilityAccount>;
    if (existing) {
      existing.set('statementBalance', v.statementBalance == null ? null : v.statementBalance.toFixed(4));
      existing.set('minimumPayment', v.minimumPayment.toFixed(4));
      existing.set('dueDay', v.dueDay);
      existing.set('statementDate', v.statementDate);
      existing.set('autopayEnabled', v.autopayEnabled);
      existing.set('autopayType', v.autopayType);
      existing.set('autopayAmount', v.autopayAmount == null ? null : v.autopayAmount.toFixed(4));
      existing.set('paymentAccountId', v.paymentAccountId);
      existing.set('creditLimit', v.creditLimit == null ? null : v.creditLimit.toFixed(4));
      await existing.save();
      row = existing;
    } else {
      row = await LiabilityAccount.create({
        accountId,
        householdId: household.id,
        statementBalance: v.statementBalance == null ? null : v.statementBalance.toFixed(4),
        minimumPayment: v.minimumPayment.toFixed(4),
        dueDay: v.dueDay,
        statementDate: v.statementDate,
        autopayEnabled: v.autopayEnabled,
        autopayType: v.autopayType,
        autopayAmount: v.autopayAmount == null ? null : v.autopayAmount.toFixed(4),
        paymentAccountId: v.paymentAccountId,
        creditLimit: v.creditLimit == null ? null : v.creditLimit.toFixed(4),
      });
    }

    res.json(serializeProfile(row));
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// POST /api/credit-cards/:accountId/payment — materialize a forecast payment
// ---------------------------------------------------------------------------

/** Marker embedded in a planned event's notes to make the feed idempotent. */
function cardPaymentTag(accountId: number): string {
  return `[cc-payment:${accountId}]`;
}

router.post('/:accountId/payment', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const accountId = parseInt(req.params.accountId, 10);
    if (!Number.isInteger(accountId) || accountId < 1) {
      res.status(400).json({ error: 'Invalid accountId' });
      return;
    }

    const account = await requireCardAccount(req, res, accountId);
    if (!account) return;

    const asOf = parseAsOf(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const strategyRaw = String(body.amountStrategy ?? 'statement');
    if (!PAYMENT_STRATEGIES.has(strategyRaw)) {
      res.status(400).json({
        error: `amountStrategy must be one of: ${Array.from(PAYMENT_STRATEGIES).join(', ')}`,
      });
      return;
    }

    const profile = await LiabilityAccount.findOne({ where: { accountId } });
    const currentBalance = await currentOwed(account, asOf);
    const statementBalance =
      profile && profile.statementBalance != null ? Number(profile.statementBalance) : currentBalance;
    const minimumPayment = profile ? Number(profile.minimumPayment) : 0;
    const dueDay = profile ? profile.dueDay : null;

    let amount: number;
    if (strategyRaw === 'minimum') amount = minimumPayment;
    else if (strategyRaw === 'current') amount = currentBalance;
    else amount = statementBalance;

    if (!(amount > 0)) {
      res.status(400).json({
        error: 'Nothing to pay for the chosen strategy — set a statement balance or minimum payment first',
      });
      return;
    }

    const currency = account.defaultCurrency ?? 'CAD';
    const expectedDate = dueDay != null ? nextDueDate(dueDay, asOf) : asOf;
    const tag = cardPaymentTag(accountId);

    // Idempotent per card: replace any prior planned (unposted) cc-payment for
    // this card so re-planning never accumulates duplicates. Posted (paid)
    // events are preserved as history.
    await PlannedEvent.destroy({
      where: {
        householdId: household.id,
        accountId,
        source: 'credit_card',
        status: 'planned',
      },
    });

    const plannedEvent = await PlannedEvent.create({
      userId: user.id,
      householdId: household.id,
      accountId,
      type: 'debt_payment',
      name: `${account.name} payment`,
      amount: amount.toFixed(4),
      currency,
      expectedDate,
      recurrenceRule: null,
      source: 'credit_card',
      status: 'planned',
      linkedTransactionId: null,
      notes: tag,
    });

    // Return the resulting safe-to-spend so the UI can warn when this payment
    // pushes the household into the red without a follow-up request.
    let safeToSpend: SafeToSpendResult | null = null;
    try {
      safeToSpend = await computeSafeToSpend({
        userId: user.id,
        householdId: household.id,
        currency,
        asOfDate: asOf,
      });
    } catch {
      safeToSpend = null;
    }

    res.status(201).json({
      plannedEvent: {
        id: plannedEvent.id,
        accountId: plannedEvent.accountId,
        type: plannedEvent.type,
        name: plannedEvent.name,
        amount: String(plannedEvent.amount),
        currency: plannedEvent.currency,
        expectedDate: plannedEvent.expectedDate,
        source: plannedEvent.source,
        status: plannedEvent.status,
        linkedTransactionId: plannedEvent.linkedTransactionId,
      },
      safeToSpend,
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// POST /api/credit-cards/:accountId/mark-paid — confirm a payment
// ---------------------------------------------------------------------------

router.post('/:accountId/mark-paid', async (req, res, next) => {
  try {
    const accountId = parseInt(req.params.accountId, 10);
    if (!Number.isInteger(accountId) || accountId < 1) {
      res.status(400).json({ error: 'Invalid accountId' });
      return;
    }

    const account = await requireCardAccount(req, res, accountId);
    if (!account) return;

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Resolve which planned event to mark paid: an explicit id, else the
    // card's current planned cc-payment event.
    let plannedEvent: InstanceType<typeof PlannedEvent> | null = null;
    if (body.plannedEventId != null && body.plannedEventId !== '') {
      const id = Number(body.plannedEventId);
      if (!Number.isInteger(id) || id < 1) {
        res.status(400).json({ error: 'plannedEventId must be a positive integer' });
        return;
      }
      plannedEvent = await PlannedEvent.findOne({ where: { id, ...householdWhere(req) } });
    } else {
      plannedEvent = await PlannedEvent.findOne({
        where: {
          ...householdWhere(req),
          accountId,
          source: 'credit_card',
          status: 'planned',
        },
        order: [['expectedDate', 'ASC']],
      });
    }

    if (!plannedEvent) {
      res.status(404).json({ error: 'No planned card payment to mark paid' });
      return;
    }

    // An optional linked transaction must belong to the household.
    let linkedTransactionId: number | null = plannedEvent.linkedTransactionId;
    if (body.transactionId != null && body.transactionId !== '') {
      const txnId = Number(body.transactionId);
      if (!Number.isInteger(txnId) || txnId < 1) {
        res.status(400).json({ error: 'transactionId must be a positive integer' });
        return;
      }
      const txn = await Transaction.findOne({
        where: { id: txnId, ...householdWhere(req) },
        attributes: ['id'],
      });
      if (!txn) {
        res.status(400).json({ error: 'transactionId must reference a transaction in your household' });
        return;
      }
      linkedTransactionId = txnId;
    }

    plannedEvent.set('status', 'posted');
    plannedEvent.set('linkedTransactionId', linkedTransactionId);
    await plannedEvent.save();

    res.json({
      plannedEvent: {
        id: plannedEvent.id,
        accountId: plannedEvent.accountId,
        status: plannedEvent.status,
        linkedTransactionId: plannedEvent.linkedTransactionId,
      },
    });
  } catch (e) {
    next(e);
  }
});

export default router;
