import { Router } from 'express';
import { Op } from 'sequelize';
import {
  PartnerSettlement,
  PARTNER_SETTLEMENT_DIRECTIONS,
  type PartnerSettlementDirection,
} from '../models/PartnerSettlement';
import { Contact } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  recordAudit,
} from '../audit/log';
import {
  FINANCE_EVENT_TYPES,
  FINANCE_EVENT_ENTITY_TYPES,
  recordFinanceEvent,
} from '../events/financeEvents';

const router = Router();

type ValidationResult =
  | { ok: true; value: NormalizedSettlementInput }
  | { ok: false; status: number; error: string };

type NormalizedSettlementInput = {
  contactId: number;
  direction: PartnerSettlementDirection;
  currency: string;
  amount: string;
  settledDate: string;
  notes: string | null;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayDateOnly(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Pure validator for POST /api/settlements bodies. Exported so unit tests can
 * exercise validation without spinning up the database.
 *
 * Returns either a `{ ok: true }` result with normalized fields or
 * `{ ok: false }` with a status + error message that mirrors what the route
 * returns to the client.
 */
export function validateSettlementInput(
  raw: Record<string, unknown>
): ValidationResult {
  const contactIdRaw = raw.contactId;
  const contactId = Number(contactIdRaw);
  if (!Number.isInteger(contactId) || contactId < 1) {
    return { ok: false, status: 400, error: 'contactId is required' };
  }

  const directionRaw = String(raw.direction ?? '');
  if (
    !(PARTNER_SETTLEMENT_DIRECTIONS as readonly string[]).includes(directionRaw)
  ) {
    return {
      ok: false,
      status: 400,
      error: `direction must be one of: ${PARTNER_SETTLEMENT_DIRECTIONS.join(', ')}`,
    };
  }
  const direction = directionRaw as PartnerSettlementDirection;

  const currencyRaw = String(raw.currency ?? '').trim().toUpperCase();
  if (currencyRaw.length !== 3) {
    return {
      ok: false,
      status: 400,
      error: 'currency must be a 3-letter ISO code',
    };
  }

  const amountNumber = Number(raw.amount);
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    return {
      ok: false,
      status: 400,
      error: 'amount must be a positive number',
    };
  }

  let settledDate = '';
  if (raw.settledDate == null || raw.settledDate === '') {
    settledDate = todayDateOnly();
  } else {
    settledDate = String(raw.settledDate);
    if (!ISO_DATE_RE.test(settledDate)) {
      return {
        ok: false,
        status: 400,
        error: 'settledDate must be YYYY-MM-DD',
      };
    }
  }

  const notesRaw = raw.notes;
  const notes =
    notesRaw == null || (typeof notesRaw === 'string' && notesRaw.trim() === '')
      ? null
      : String(notesRaw);

  return {
    ok: true,
    value: {
      contactId,
      direction,
      currency: currencyRaw,
      amount: amountNumber.toFixed(4),
      settledDate,
      notes,
    },
  };
}

type SettlementResponse = {
  id: number;
  householdId: number;
  contactId: number;
  contactName: string | null;
  direction: PartnerSettlementDirection;
  currency: string;
  amount: string;
  settledDate: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

function serializeSettlement(
  row: InstanceType<typeof PartnerSettlement>,
  contactNamesById: Map<number, string>
): SettlementResponse {
  return {
    id: row.id,
    householdId: row.householdId,
    contactId: row.contactId,
    contactName: contactNamesById.get(row.contactId) ?? null,
    direction: row.direction,
    currency: row.currency,
    amount: String(row.amount),
    settledDate: row.settledDate,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get('/', async (req, res, next) => {
  try {
    const where: Record<string, unknown> = { ...householdWhere(req) };
    if (req.query.contactId) {
      const cid = parseInt(String(req.query.contactId), 10);
      if (Number.isInteger(cid) && cid > 0) where.contactId = cid;
    }
    if (req.query.currency) {
      where.currency = String(req.query.currency).toUpperCase().slice(0, 3);
    }

    const rows = await PartnerSettlement.findAll({
      where,
      order: [
        ['settledDate', 'DESC'],
        ['createdAt', 'DESC'],
      ],
    });

    const contactIds = Array.from(new Set(rows.map((r) => r.contactId)));
    const contacts = contactIds.length
      ? await Contact.findAll({
          where: { id: { [Op.in]: contactIds }, ...householdWhere(req) },
          attributes: ['id', 'name'],
          raw: true,
        })
      : [];
    const contactNamesById = new Map(
      (contacts as Array<{ id: number; name: string }>).map((c) => [c.id, c.name])
    );

    res.json({
      data: rows.map((r) => serializeSettlement(r, contactNamesById)),
    });
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = validateSettlementInput(body);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    const contact = await Contact.findOne({
      where: { id: result.value.contactId, householdId: household.id },
      attributes: ['id', 'name'],
    });
    if (!contact) {
      res
        .status(400)
        .json({ error: 'contactId must reference a household contact' });
      return;
    }

    const row = await PartnerSettlement.create({
      householdId: household.id,
      recordedByUserId: currentAuth(req).user.id,
      contactId: contact.id,
      direction: result.value.direction,
      currency: result.value.currency,
      amount: result.value.amount,
      settledDate: result.value.settledDate,
      notes: result.value.notes,
    });

    await recordAudit({
      req,
      action: AUDIT_ACTIONS.SettlementCreated,
      entityType: AUDIT_ENTITY_TYPES.Settlement,
      entityId: row.id,
      summary: `Recorded settlement: ${result.value.direction} ${result.value.currency} ${result.value.amount} with ${contact.name}`,
      after: {
        contactId: contact.id,
        contactName: contact.name,
        direction: result.value.direction,
        currency: result.value.currency,
        amount: result.value.amount,
        settledDate: result.value.settledDate,
        notes: result.value.notes,
      },
    });

    // Domain event for the stream (issue #238). Independent of the
    // audit-log write above; payload is the canonical settlement input
    // (no contact-name dereference — the consumer can resolve from
    // contactId if needed).
    await recordFinanceEvent({
      req,
      type: FINANCE_EVENT_TYPES.SettlementCreated,
      entityType: FINANCE_EVENT_ENTITY_TYPES.Settlement,
      entityId: row.id,
      payload: {
        contactId: contact.id,
        direction: result.value.direction,
        currency: result.value.currency,
        amount: result.value.amount,
        settledDate: result.value.settledDate,
        notes: result.value.notes,
      },
    });

    const contactNames = new Map<number, string>([[contact.id, contact.name]]);
    res.status(201).json(serializeSettlement(row, contactNames));
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
    const row = await PartnerSettlement.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const snapshot = {
      contactId: row.contactId,
      direction: row.direction,
      currency: row.currency,
      amount: row.amount,
      settledDate: row.settledDate,
      notes: row.notes,
    };
    const settlementId = row.id;
    await row.destroy();
    await recordAudit({
      req,
      action: AUDIT_ACTIONS.SettlementDeleted,
      entityType: AUDIT_ENTITY_TYPES.Settlement,
      entityId: settlementId,
      summary: `Deleted settlement #${settlementId}`,
      before: snapshot,
    });
    await recordFinanceEvent({
      req,
      type: FINANCE_EVENT_TYPES.SettlementDeleted,
      entityType: FINANCE_EVENT_ENTITY_TYPES.Settlement,
      entityId: settlementId,
      payload: snapshot,
    });
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
