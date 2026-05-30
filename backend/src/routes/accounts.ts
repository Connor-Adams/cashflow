import { Router } from 'express';
import { Op } from 'sequelize';
import { Account, Transaction, sequelize } from '../models';
import * as env from '../config/env';
import { currentAuth } from '../auth/middleware';
import { visibleAccountWhere } from '../auth/scope';
import { pendingTotal } from '../transactions/status';
import { mergeAccounts } from '../services/accountMerge';

const router = Router();
const ACCOUNT_TYPES = new Set([
  'checking',
  'savings',
  'credit_card',
  'investment',
  'loan',
  'cash',
  'other',
]);

function normalizeAccountType(raw: unknown): string {
  const value = String(raw ?? '').trim();
  return ACCOUNT_TYPES.has(value) ? value : 'checking';
}

router.get('/', async (req, res, next) => {
  try {
    const includeMerged = req.query.includeMerged === 'true';
    const baseWhere = visibleAccountWhere(req);
    const where = includeMerged
      ? baseWhere
      : { ...baseWhere, mergedIntoId: { [Op.is]: null } };
    const rows = await Account.findAll({
      where,
      order: [['name', 'ASC']],
    });
    res.json(rows.map(r => {
      const json = r.toJSON() as Record<string, unknown>
      const raw = (json.notes as string | null) ?? null
      json.notesPreview = raw ? raw.slice(0, 100) : null
      delete json.notes
      return json
    }));
  } catch (e) {
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const { name, owner, shortCode, defaultCurrency, visibility, accountType, notes } = (req.body || {}) as Record<
      string,
      unknown
    >;
    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    let notesValue: string | null = null;
    if (notes !== undefined && notes !== null) {
      const trimmedNotes = String(notes).trim();
      if (trimmedNotes.length > 4000) {
        res.status(400).json({ error: 'NOTES_TOO_LONG' });
        return;
      }
      notesValue = trimmedNotes || null;
    }
    const dc =
      defaultCurrency != null && String(defaultCurrency).trim() !== ''
        ? String(defaultCurrency).trim().toUpperCase().slice(0, 3)
        : env.defaultCurrency;
    const row = await Account.create({
      name: String(name),
      owner: (owner as string) || 'me',
      householdId: household.id,
      ownerUserId: user.id,
      visibility: visibility === 'shared' ? 'shared' : 'private',
      accountType: normalizeAccountType(accountType),
      shortCode: (shortCode as string) || null,
      defaultCurrency: dc,
      notes: notesValue,
    });
    res.status(201).json(row);
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const account = await Account.findOne({ where: { id, ...visibleAccountWhere(req) } });
    if (!account) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(account);
  } catch (e) {
    next(e);
  }
});

router.get('/:id/pending-total', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const account = await Account.findOne({ where: { id, ...visibleAccountWhere(req) } });
    if (!account) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const asOf =
      typeof req.query.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asOf)
        ? req.query.asOf
        : null;
    res.json(await pendingTotal({ accountId: account.id, householdId: account.householdId, asOf }));
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const account = await Account.findOne({ where: { id, ...visibleAccountWhere(req) } });
    if (!account) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { name, owner, shortCode, defaultCurrency, visibility, accountType, closedAt, notes } = (req.body || {}) as Record<
      string,
      unknown
    >;
    if (name !== undefined) {
      const value = String(name).trim();
      if (!value) {
        res.status(400).json({ error: 'name cannot be empty' });
        return;
      }
      account.set('name', value);
    }
    if (owner !== undefined) {
      const value = String(owner).trim();
      if (!value) {
        res.status(400).json({ error: 'owner cannot be empty' });
        return;
      }
      account.set('owner', value);
    }
    if (shortCode !== undefined) {
      const value = String(shortCode).trim();
      account.set('shortCode', value || null);
    }
    if (defaultCurrency !== undefined) {
      const value = String(defaultCurrency).trim();
      account.set(
        'defaultCurrency',
        value ? value.toUpperCase().slice(0, 3) : env.defaultCurrency
      );
    }
    if (visibility !== undefined) {
      account.set('visibility', visibility === 'shared' ? 'shared' : 'private');
    }
    if (accountType !== undefined) {
      account.set('accountType', normalizeAccountType(accountType));
    }
    if (closedAt !== undefined) {
      if (closedAt === null || closedAt === '') {
        account.set('closedAt', null);
      } else {
        const raw = String(closedAt).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          res.status(400).json({ error: 'closedAt must be YYYY-MM-DD or null' });
          return;
        }
        account.set('closedAt', raw);
      }
    }
    if (notes !== undefined) {
      const trimmedNotes = String(notes ?? '').trim();
      if (trimmedNotes.length > 4000) {
        res.status(400).json({ error: 'NOTES_TOO_LONG' });
        return;
      }
      account.set('notes', trimmedNotes || null);
    }
    await account.save();
    res.json(account);
  } catch (e) {
    next(e);
  }
});

router.post('/:sourceId/merge-into/:targetId', async (req, res, next) => {
  try {
    const sourceId = parseInt(req.params.sourceId, 10);
    const targetId = parseInt(req.params.targetId, 10);
    if (Number.isNaN(sourceId) || Number.isNaN(targetId)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const { household } = currentAuth(req);
    const outcome = await mergeAccounts(sourceId, targetId, household.id);
    if (!outcome.ok) {
      res.status(400).json({ error: outcome.error });
      return;
    }
    // Reload both accounts after the merge so the response reflects the new
    // state (source has mergedIntoId set, target is unchanged).
    const [source, target] = await Promise.all([
      Account.findOne({ where: { id: sourceId } }),
      Account.findOne({ where: { id: targetId } }),
    ]);
    res.json({ source, target, ...outcome.result });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const account = await Account.findOne({ where: { id, ...visibleAccountWhere(req) } });
    if (!account) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await sequelize.transaction(async (t) => {
      await Transaction.destroy({ where: { accountId: id }, transaction: t });
      await account.destroy({ transaction: t });
    });
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
