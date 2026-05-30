import { Router } from 'express';
import { Contact } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';

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
    const row = await Contact.create({
      householdId: household.id,
      name,
      notes: b.notes != null ? String(b.notes) : null,
      isPartner,
    });
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
