import { Router } from 'express';
import { Op } from 'sequelize';
import { SavedFilter, SAVED_FILTER_NAME_MAX_LENGTH } from '../models/SavedFilter';
import { currentAuth } from '../auth/middleware';

const KNOWN_PAGES = ['transactions'] as const;

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const page = typeof req.query.page === 'string' ? req.query.page : undefined;
    const where: Record<string, unknown> = { userId: user.id };
    if (page) where.page = page;
    const filters = await SavedFilter.findAll({
      where,
      order: [
        ['position', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });
    res.json(filters);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const { name, page, filterJson } = req.body as {
      name: unknown;
      page: unknown;
      filterJson: unknown;
    };

    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > SAVED_FILTER_NAME_MAX_LENGTH) {
      res.status(400).json({ code: 'INVALID_NAME', message: 'Name must be 1–64 characters.' });
      return;
    }
    if (typeof page !== 'string' || !(KNOWN_PAGES as readonly string[]).includes(page)) {
      res.status(400).json({ code: 'INVALID_PAGE', message: 'Unknown page.' });
      return;
    }
    if (filterJson === null || Array.isArray(filterJson) || typeof filterJson !== 'object') {
      res.status(400).json({ code: 'INVALID_FILTER', message: 'filterJson must be an object.' });
      return;
    }

    const trimmedName = name.trim();
    const existing = await SavedFilter.findOne({
      where: { userId: user.id, page, name: trimmedName },
    });
    if (existing) {
      res.status(400).json({ code: 'DUPLICATE_NAME', message: 'A filter with that name exists.' });
      return;
    }

    const maxPos = await SavedFilter.max<number, SavedFilter>('position', {
      where: { userId: user.id, page },
    });
    const position = typeof maxPos === 'number' ? maxPos + 1 : 0;

    const filter = await SavedFilter.create({
      userId: user.id,
      name: trimmedName,
      page,
      filterJson: filterJson as Record<string, unknown>,
      position,
    });
    res.status(201).json(filter);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(404).json({ code: 'NOT_FOUND' });
      return;
    }
    const filter = await SavedFilter.findOne({ where: { id, userId: user.id } });
    if (!filter) {
      res.status(404).json({ code: 'NOT_FOUND' });
      return;
    }

    const { name, filterJson, position } = req.body as {
      name?: unknown;
      filterJson?: unknown;
      position?: unknown;
    };

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > SAVED_FILTER_NAME_MAX_LENGTH) {
        res.status(400).json({ code: 'INVALID_NAME', message: 'Name must be 1–64 characters.' });
        return;
      }
      const trimmedName = name.trim();
      if (trimmedName !== filter.name) {
        const conflict = await SavedFilter.findOne({
          where: { userId: user.id, page: filter.page, name: trimmedName, id: { [Op.ne]: filter.id } },
        });
        if (conflict) {
          res.status(400).json({ code: 'DUPLICATE_NAME', message: 'A filter with that name exists.' });
          return;
        }
      }
      filter.name = name.trim();
    }

    if (filterJson !== undefined) {
      if (filterJson === null || Array.isArray(filterJson) || typeof filterJson !== 'object') {
        res.status(400).json({ code: 'INVALID_FILTER', message: 'filterJson must be an object.' });
        return;
      }
      filter.filterJson = filterJson as Record<string, unknown>;
    }

    if (position !== undefined) {
      if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) {
        res.status(400).json({ code: 'INVALID_POSITION' });
        return;
      }
      filter.position = position;
    }

    await filter.save();
    res.json(filter);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(404).json({ code: 'NOT_FOUND' });
      return;
    }
    const filter = await SavedFilter.findOne({ where: { id, userId: user.id } });
    if (!filter) {
      res.status(404).json({ code: 'NOT_FOUND' });
      return;
    }
    await filter.destroy();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
