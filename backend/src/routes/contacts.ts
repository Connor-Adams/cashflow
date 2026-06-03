import { Router } from 'express';
import { Contact, Reimbursement, Transaction } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { findOrCreateContactByName } from '../contacts/findOrCreateContact';
import {
  summarizeOpenForContact,
  todayIso,
  type ReimbursementRow,
} from '../reimbursements/serialize';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const rows = await Contact.findAll({
      where: householdWhere(req),
      order: [['name', 'ASC']],
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/**
 * #374 — Contact detail. Returns the Contact plus an `openReimbursements`
 * aggregate so the UI can render "Open reimbursements: $X across Y items" and
 * the per-item list without a second round-trip. Only effectively-open claims
 * (`expected` or derived-overdue) count toward the aggregate; received and
 * waived are excluded by `summarizeOpenForContact`.
 *
 * Each item in `openReimbursements.items` is a fully-serialized
 * `ReimbursementView` so the frontend reuses the same shape it already
 * renders on /reimbursements.
 */
router.get('/:id', async (req, res, next) => {
  try {
    currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const contact = await Contact.findOne({
      where: { id, ...householdWhere(req) },
    });
    if (!contact) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const today = todayIso();
    const rows = await Reimbursement.findAll({
      where: { ...householdWhere(req), contactId: id },
      include: [
        { model: Contact, as: 'contact', attributes: ['id', 'name'], required: false },
        {
          model: Transaction,
          as: 'transaction',
          attributes: ['id', 'date', 'merchantClean', 'amount', 'currency'],
          required: false,
        },
        {
          model: Transaction,
          as: 'repaymentTransaction',
          attributes: ['id', 'date', 'merchantClean', 'amount', 'currency'],
          required: false,
        },
      ],
      order: [
        ['due_date', 'ASC'],
        ['created_at', 'DESC'],
      ],
    });
    const open = summarizeOpenForContact(
      rows.map((r) => r as unknown as ReimbursementRow),
      today,
    );
    res.json({
      id: contact.id,
      householdId: contact.householdId,
      name: contact.name,
      notes: contact.notes,
      isPartner: contact.isPartner,
      openReimbursements: open,
      today,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * #375 — coerce common boolean representations from a JSON body so the
 * `is_partner` flag can be set from a checkbox (true/false), an HTML form
 * (the strings "true"/"false"), or a 0/1 integer. Returns null for invalid
 * input so the route can 400.
 */
function coerceBool(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === 'false' || raw === 0 || raw === '0') return false;
  return null;
}

router.post('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const b = (req.body || {}) as Record<string, unknown>;
    const name = String(b.name ?? '').trim();
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    let isPartner = false;
    if (b.isPartner !== undefined) {
      const parsed = coerceBool(b.isPartner);
      if (parsed === null) {
        res.status(400).json({ error: 'isPartner must be boolean' });
        return;
      }
      isPartner = parsed;
    }
    const row = await findOrCreateContactByName(household.id, name);
    let changed = false;
    if (b.notes != null) { row.set('notes', String(b.notes)); changed = true; }
    if (isPartner) { row.set('isPartner', true); changed = true; }
    if (changed) await row.save();
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Contact.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      if (!name) {
        res.status(400).json({ error: 'name cannot be empty' });
        return;
      }
      row.set('name', name);
    }
    if (b.notes !== undefined) row.set('notes', b.notes != null ? String(b.notes) : null);
    if (b.isPartner !== undefined) {
      const parsed = coerceBool(b.isPartner);
      if (parsed === null) {
        res.status(400).json({ error: 'isPartner must be boolean' });
        return;
      }
      row.set('isPartner', parsed);
    }
    await row.save();
    res.json(row);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Contact.findOne({ where: { id, ...householdWhere(req) } });
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
