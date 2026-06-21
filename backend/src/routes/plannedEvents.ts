import { Router } from 'express';
import { Op } from 'sequelize';
import {
  PlannedEvent,
  PLANNED_EVENT_TYPES,
  PLANNED_EVENT_SOURCES,
  PLANNED_EVENT_STATUSES,
  type PlannedEventType,
  type PlannedEventSource,
  type PlannedEventStatus,
} from '../models/PlannedEvent';
import { Account, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';

const router = Router();

type NormalizedPlannedEventInput = {
  accountId: number | null;
  type: PlannedEventType;
  name: string;
  amount: string;
  currency: string;
  expectedDate: string;
  recurrenceRule: string | null;
  source: PlannedEventSource;
  status: PlannedEventStatus;
  linkedTransactionId: number | null;
  notes: string | null;
};

type NormalizedPlannedEventPatch = Partial<NormalizedPlannedEventInput>;

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME_LENGTH = 255;
const MAX_RECURRENCE_LENGTH = 1024;
const MAX_NOTES_LENGTH = 4096;

function normalizeOptionalString(
  raw: unknown,
  maxLength: number
): string | null {
  if (raw == null) return null;
  if (typeof raw !== 'string') return String(raw).slice(0, maxLength);
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function normalizeNullableInt(raw: unknown): number | null | 'invalid' {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 'invalid';
  return n;
}

/**
 * Pure validator for POST /api/planned-events bodies. Exported so unit
 * tests can exercise validation without touching the database.
 *
 * Required: type, name, amount, currency, expectedDate.
 * Optional: accountId, recurrenceRule, source (defaults to 'manual'),
 *           status (defaults to 'planned'), linkedTransactionId, notes.
 *
 * Amount may be positive or zero — semantically, the SIGN of a planned
 * event lives in the `type` (income vs expense). We accept any finite
 * non-negative number and store it as DECIMAL(14,4). Downstream forecast
 * code maps `type` to direction.
 */
export function validatePlannedEventInput(
  raw: Record<string, unknown>
): ValidationResult<NormalizedPlannedEventInput> {
  const typeRaw = String(raw.type ?? '');
  if (!(PLANNED_EVENT_TYPES as readonly string[]).includes(typeRaw)) {
    return {
      ok: false,
      status: 400,
      error: `type must be one of: ${PLANNED_EVENT_TYPES.join(', ')}`,
    };
  }
  const type = typeRaw as PlannedEventType;

  const name = normalizeOptionalString(raw.name, MAX_NAME_LENGTH);
  if (!name) {
    return { ok: false, status: 400, error: 'name is required' };
  }

  const amountNumber = Number(raw.amount);
  if (!Number.isFinite(amountNumber) || amountNumber < 0) {
    return {
      ok: false,
      status: 400,
      error: 'amount must be a non-negative number',
    };
  }

  const currencyRaw = String(raw.currency ?? '').trim().toUpperCase();
  if (currencyRaw.length !== 3) {
    return {
      ok: false,
      status: 400,
      error: 'currency must be a 3-letter ISO code',
    };
  }

  if (raw.expectedDate == null || raw.expectedDate === '') {
    return { ok: false, status: 400, error: 'expectedDate is required' };
  }
  const expectedDate = String(raw.expectedDate);
  if (!ISO_DATE_RE.test(expectedDate)) {
    return {
      ok: false,
      status: 400,
      error: 'expectedDate must be YYYY-MM-DD',
    };
  }

  const accountIdParsed = normalizeNullableInt(raw.accountId);
  if (accountIdParsed === 'invalid') {
    return {
      ok: false,
      status: 400,
      error: 'accountId must be a positive integer or null',
    };
  }

  const recurrenceRule = normalizeOptionalString(
    raw.recurrenceRule,
    MAX_RECURRENCE_LENGTH
  );

  let source: PlannedEventSource = 'manual';
  if (raw.source != null && raw.source !== '') {
    const sourceCandidate = String(raw.source);
    if (!(PLANNED_EVENT_SOURCES as readonly string[]).includes(sourceCandidate)) {
      return {
        ok: false,
        status: 400,
        error: `source must be one of: ${PLANNED_EVENT_SOURCES.join(', ')}`,
      };
    }
    source = sourceCandidate as PlannedEventSource;
  }

  let status: PlannedEventStatus = 'planned';
  if (raw.status != null && raw.status !== '') {
    const statusCandidate = String(raw.status);
    if (
      !(PLANNED_EVENT_STATUSES as readonly string[]).includes(statusCandidate)
    ) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${PLANNED_EVENT_STATUSES.join(', ')}`,
      };
    }
    status = statusCandidate as PlannedEventStatus;
  }

  const linkedTransactionIdParsed = normalizeNullableInt(raw.linkedTransactionId);
  if (linkedTransactionIdParsed === 'invalid') {
    return {
      ok: false,
      status: 400,
      error: 'linkedTransactionId must be a positive integer or null',
    };
  }

  const notes = normalizeOptionalString(raw.notes, MAX_NOTES_LENGTH);

  return {
    ok: true,
    value: {
      accountId: accountIdParsed,
      type,
      name,
      amount: amountNumber.toFixed(4),
      currency: currencyRaw,
      expectedDate,
      recurrenceRule,
      source,
      status,
      linkedTransactionId: linkedTransactionIdParsed,
      notes,
    },
  };
}

/**
 * Pure validator for PUT /api/planned-events/:id bodies. Each field is
 * optional; unknown fields are ignored. Returns the partial input.
 */
export function validatePlannedEventPatch(
  raw: Record<string, unknown>
): ValidationResult<NormalizedPlannedEventPatch> {
  const out: NormalizedPlannedEventPatch = {};

  if (raw.type !== undefined) {
    const typeCandidate = String(raw.type);
    if (!(PLANNED_EVENT_TYPES as readonly string[]).includes(typeCandidate)) {
      return {
        ok: false,
        status: 400,
        error: `type must be one of: ${PLANNED_EVENT_TYPES.join(', ')}`,
      };
    }
    out.type = typeCandidate as PlannedEventType;
  }

  if (raw.name !== undefined) {
    const name = normalizeOptionalString(raw.name, MAX_NAME_LENGTH);
    if (!name) {
      return { ok: false, status: 400, error: 'name cannot be empty' };
    }
    out.name = name;
  }

  if (raw.amount !== undefined) {
    const amountNumber = Number(raw.amount);
    if (!Number.isFinite(amountNumber) || amountNumber < 0) {
      return {
        ok: false,
        status: 400,
        error: 'amount must be a non-negative number',
      };
    }
    out.amount = amountNumber.toFixed(4);
  }

  if (raw.currency !== undefined) {
    const currency = String(raw.currency ?? '').trim().toUpperCase();
    if (currency.length !== 3) {
      return {
        ok: false,
        status: 400,
        error: 'currency must be a 3-letter ISO code',
      };
    }
    out.currency = currency;
  }

  if (raw.expectedDate !== undefined) {
    const expected = String(raw.expectedDate);
    if (!ISO_DATE_RE.test(expected)) {
      return {
        ok: false,
        status: 400,
        error: 'expectedDate must be YYYY-MM-DD',
      };
    }
    out.expectedDate = expected;
  }

  if (raw.accountId !== undefined) {
    const accountIdParsed = normalizeNullableInt(raw.accountId);
    if (accountIdParsed === 'invalid') {
      return {
        ok: false,
        status: 400,
        error: 'accountId must be a positive integer or null',
      };
    }
    out.accountId = accountIdParsed;
  }

  if (raw.recurrenceRule !== undefined) {
    out.recurrenceRule = normalizeOptionalString(
      raw.recurrenceRule,
      MAX_RECURRENCE_LENGTH
    );
  }

  if (raw.source !== undefined) {
    const sourceCandidate = String(raw.source);
    if (!(PLANNED_EVENT_SOURCES as readonly string[]).includes(sourceCandidate)) {
      return {
        ok: false,
        status: 400,
        error: `source must be one of: ${PLANNED_EVENT_SOURCES.join(', ')}`,
      };
    }
    out.source = sourceCandidate as PlannedEventSource;
  }

  if (raw.status !== undefined) {
    const statusCandidate = String(raw.status);
    if (
      !(PLANNED_EVENT_STATUSES as readonly string[]).includes(statusCandidate)
    ) {
      return {
        ok: false,
        status: 400,
        error: `status must be one of: ${PLANNED_EVENT_STATUSES.join(', ')}`,
      };
    }
    out.status = statusCandidate as PlannedEventStatus;
  }

  if (raw.linkedTransactionId !== undefined) {
    const linkedTransactionIdParsed = normalizeNullableInt(
      raw.linkedTransactionId
    );
    if (linkedTransactionIdParsed === 'invalid') {
      return {
        ok: false,
        status: 400,
        error: 'linkedTransactionId must be a positive integer or null',
      };
    }
    out.linkedTransactionId = linkedTransactionIdParsed;
  }

  if (raw.notes !== undefined) {
    out.notes = normalizeOptionalString(raw.notes, MAX_NOTES_LENGTH);
  }

  return { ok: true, value: out };
}

type PlannedEventResponse = {
  id: number;
  userId: number;
  householdId: number;
  accountId: number | null;
  type: PlannedEventType;
  name: string;
  amount: string;
  currency: string;
  expectedDate: string;
  recurrenceRule: string | null;
  source: PlannedEventSource;
  status: PlannedEventStatus;
  linkedTransactionId: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

function serializePlannedEvent(
  row: InstanceType<typeof PlannedEvent>
): PlannedEventResponse {
  return {
    id: row.id,
    userId: row.userId,
    householdId: row.householdId,
    accountId: row.accountId,
    type: row.type,
    name: row.name,
    amount: String(row.amount),
    currency: row.currency,
    expectedDate: row.expectedDate,
    recurrenceRule: row.recurrenceRule,
    source: row.source,
    status: row.status,
    linkedTransactionId: row.linkedTransactionId,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Verify an account (if supplied) belongs to the caller's household. Returns
 * a string error if the check fails, or null on success / null id.
 */
async function checkAccountInHousehold(
  accountId: number | null,
  householdId: number
): Promise<string | null> {
  if (accountId == null) return null;
  const account = await Account.findOne({
    where: { id: accountId, householdId },
    attributes: ['id'],
  });
  if (!account) {
    return 'accountId must reference an account in your household';
  }
  return null;
}

/**
 * Verify a transaction (if supplied) belongs to the caller's household.
 */
async function checkTransactionInHousehold(
  transactionId: number | null,
  householdId: number
): Promise<string | null> {
  if (transactionId == null) return null;
  const txn = await Transaction.findOne({
    where: { id: transactionId, householdId },
    attributes: ['id'],
  });
  if (!txn) {
    return 'linkedTransactionId must reference a transaction in your household';
  }
  return null;
}

router.get('/', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req), kind: 'planned' };

    if (req.query.type) {
      const typeRaw = String(req.query.type);
      if ((PLANNED_EVENT_TYPES as readonly string[]).includes(typeRaw)) {
        where.type = typeRaw;
      }
    }
    if (req.query.status) {
      const statusRaw = String(req.query.status);
      if ((PLANNED_EVENT_STATUSES as readonly string[]).includes(statusRaw)) {
        where.status = statusRaw;
      }
    }
    if (req.query.accountId) {
      const aid = parseInt(String(req.query.accountId), 10);
      if (Number.isInteger(aid) && aid > 0) where.accountId = aid;
    }
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }
    if (req.query.dateFrom) {
      const dateFrom = String(req.query.dateFrom);
      if (ISO_DATE_RE.test(dateFrom)) {
        where.expectedDate = {
          ...(where.expectedDate as Record<symbol, string> | undefined),
          [Op.gte]: dateFrom,
        };
      }
    }
    if (req.query.dateTo) {
      const dateTo = String(req.query.dateTo);
      if (ISO_DATE_RE.test(dateTo)) {
        where.expectedDate = {
          ...(where.expectedDate as Record<symbol, string> | undefined),
          [Op.lte]: dateTo,
        };
      }
    }

    const rows = await PlannedEvent.findAll({
      where,
      order: [
        ['expectedDate', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });

    res.json({ data: rows.map(serializePlannedEvent) });
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await PlannedEvent.findOne({
      where: { id, kind: 'planned', ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(serializePlannedEvent(row));
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validatePlannedEventInput(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const accountErr = await checkAccountInHousehold(
      result.value.accountId,
      household.id
    );
    if (accountErr) {
      res.status(400).json({ error: accountErr });
      return;
    }
    const txnErr = await checkTransactionInHousehold(
      result.value.linkedTransactionId,
      household.id
    );
    if (txnErr) {
      res.status(400).json({ error: txnErr });
      return;
    }

    const row = await PlannedEvent.create({
      userId: user.id,
      householdId: household.id,
      accountId: result.value.accountId,
      type: result.value.type,
      name: result.value.name,
      amount: result.value.amount,
      currency: result.value.currency,
      expectedDate: result.value.expectedDate,
      recurrenceRule: result.value.recurrenceRule,
      source: result.value.source,
      status: result.value.status,
      linkedTransactionId: result.value.linkedTransactionId,
      notes: result.value.notes,
    });

    res.status(201).json(serializePlannedEvent(row));
  } catch (e) {
    next(e);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await PlannedEvent.findOne({
      where: { id, kind: 'planned', ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validatePlannedEventPatch(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const patch = result.value;

    if (patch.accountId !== undefined) {
      const accountErr = await checkAccountInHousehold(
        patch.accountId,
        row.householdId
      );
      if (accountErr) {
        res.status(400).json({ error: accountErr });
        return;
      }
    }
    if (patch.linkedTransactionId !== undefined) {
      const txnErr = await checkTransactionInHousehold(
        patch.linkedTransactionId,
        row.householdId
      );
      if (txnErr) {
        res.status(400).json({ error: txnErr });
        return;
      }
    }

    if (patch.accountId !== undefined) row.set('accountId', patch.accountId);
    if (patch.type !== undefined) row.set('type', patch.type);
    if (patch.name !== undefined) row.set('name', patch.name);
    if (patch.amount !== undefined) row.set('amount', patch.amount);
    if (patch.currency !== undefined) row.set('currency', patch.currency);
    if (patch.expectedDate !== undefined) {
      row.set('expectedDate', patch.expectedDate);
    }
    if (patch.recurrenceRule !== undefined) {
      row.set('recurrenceRule', patch.recurrenceRule);
    }
    if (patch.source !== undefined) row.set('source', patch.source);
    if (patch.status !== undefined) row.set('status', patch.status);
    if (patch.linkedTransactionId !== undefined) {
      row.set('linkedTransactionId', patch.linkedTransactionId);
    }
    if (patch.notes !== undefined) row.set('notes', patch.notes);

    await row.save();
    res.json(serializePlannedEvent(row));
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await PlannedEvent.findOne({
      where: { id, kind: 'planned', ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
