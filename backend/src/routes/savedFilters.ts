import { Router } from 'express';
import { Op } from 'sequelize';
import { SavedFilter, SAVED_FILTER_NAME_MAX, SAVED_FILTER_PAGES } from '../models/SavedFilter';
import { currentAuth } from '../auth/middleware';

const router = Router();

// GET /api/saved-filters?page=transactions
router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const page = typeof req.query.page === 'string' ? req.query.page : undefined;
    const where: Record<string, unknown> = { userId: user.id };
    if (page) where.page = page;
    const filters = await SavedFilter.findAll({
      where,
      order: [['position', 'ASC'], ['createdAt', 'ASC']],
    });
    res.json(filters.map((f) => f.toJSON()));
  } catch (e) {
    next(e);
  }
});

// POST /api/saved-filters
router.post('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const body = req.body as { name?: unknown; page?: unknown; filterJson?: unknown };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > SAVED_FILTER_NAME_MAX) {
      res.status(400).json({ error: 'INVALID_NAME', message: `Name must be 1–${SAVED_FILTER_NAME_MAX} characters.` });
      return;
    }

    const page = body.page as string;
    if (!SAVED_FILTER_PAGES.includes(page as typeof SAVED_FILTER_PAGES[number])) {
      res.status(400).json({ error: 'INVALID_PAGE', message: `Page must be one of: ${SAVED_FILTER_PAGES.join(', ')}.` });
      return;
    }

    const filterJson = body.filterJson;
    if (!filterJson || typeof filterJson !== 'object' || Array.isArray(filterJson)) {
      res.status(400).json({ error: 'INVALID_FILTER', message: 'filterJson must be a non-null object.' });
      return;
    }

    const existing = await SavedFilter.findOne({
      where: { userId: user.id, page, name },
    });
    if (existing) {
      res.status(400).json({ error: 'DUPLICATE_NAME', message: `A filter named "${name}" already exists for this page.` });
      return;
    }

    const maxPos = await SavedFilter.max<number, SavedFilter>('position', {
      where: { userId: user.id, page },
    });
    const position = (maxPos ?? -1) + 1;

    const created = await SavedFilter.create({
      userId: user.id,
      name,
      page: page as typeof SAVED_FILTER_PAGES[number],
      filterJson: filterJson as Record<string, unknown>,
      position,
    });
    res.status(201).json(created.toJSON());
  } catch (e) {
    next(e);
  }
});

// PATCH /api/saved-filters/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }

    const filter = await SavedFilter.findOne({ where: { id, userId: user.id } });
    if (!filter) {
      res.status(404).json({ error: 'not found' });
      return;
    }

    const body = req.body as { name?: unknown; filterJson?: unknown; position?: unknown };
    const patch: Partial<{ name: string; filterJson: Record<string, unknown>; position: number }> = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > SAVED_FILTER_NAME_MAX) {
        res.status(400).json({ error: 'INVALID_NAME', message: `Name must be 1–${SAVED_FILTER_NAME_MAX} characters.` });
        return;
      }
      const dup = await SavedFilter.findOne({
        where: { userId: user.id, page: filter.page, name, id: { [Op.ne]: id } },
      });
      if (dup) {
        res.status(400).json({ error: 'DUPLICATE_NAME', message: `A filter named "${name}" already exists for this page.` });
        return;
      }
      patch.name = name;
    }

    if (body.filterJson !== undefined) {
      const fj = body.filterJson;
      if (!fj || typeof fj !== 'object' || Array.isArray(fj)) {
        res.status(400).json({ error: 'INVALID_FILTER' });
        return;
      }
      patch.filterJson = fj as Record<string, unknown>;
    }

    if (body.position !== undefined) {
      const pos = Number(body.position);
      if (!Number.isFinite(pos)) {
        res.status(400).json({ error: 'INVALID_POSITION' });
        return;
      }
      patch.position = Math.round(pos);
    }

    await filter.update(patch);
    res.json(filter.toJSON());
  } catch (e) {
    next(e);
  }
});

// DELETE /api/saved-filters/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const filter = await SavedFilter.findOne({ where: { id, userId: user.id } });
    if (!filter) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    await filter.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
