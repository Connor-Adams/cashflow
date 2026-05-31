import { Router } from 'express';
import { SavedFilter } from '../models';
import { currentAuth } from '../auth/middleware';

const router = Router();

const ALLOWED_PAGES = ['transactions'] as const;
type AllowedPage = (typeof ALLOWED_PAGES)[number];

function isAllowedPage(page: unknown): page is AllowedPage {
  return typeof page === 'string' && (ALLOWED_PAGES as readonly string[]).includes(page);
}

// GET / — list saved filters for current user, optionally filtered by ?page=
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

// POST / — create a saved filter
router.post('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length === 0 || name.length > 64) {
      res.status(400).json({ error: 'name must be 1–64 characters' });
      return;
    }

    if (!isAllowedPage(body.page)) {
      res.status(400).json({ error: `page must be one of: ${ALLOWED_PAGES.join(', ')}` });
      return;
    }

    const filterJson =
      body.filterJson !== null &&
      typeof body.filterJson === 'object' &&
      !Array.isArray(body.filterJson)
        ? (body.filterJson as Record<string, unknown>)
        : null;
    if (filterJson === null) {
      res.status(400).json({ error: 'filterJson must be an object' });
      return;
    }

    const filter = await SavedFilter.create({
      userId: user.id,
      name,
      page: body.page,
      filterJson,
      position: 0,
    });
    res.status(201).json(filter);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'SequelizeUniqueConstraintError') {
      res.status(409).json({ error: 'DUPLICATE_NAME' });
      return;
    }
    next(err);
  }
});

// PATCH /:id — update name, filterJson, and/or position
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const { user } = currentAuth(req);

    const filter = await SavedFilter.findByPk(id);
    if (!filter) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (filter.userId !== user.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const updates: Partial<{ name: string; filterJson: Record<string, unknown>; position: number }> =
      {};

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length === 0 || name.length > 64) {
        res.status(400).json({ error: 'name must be 1–64 characters' });
        return;
      }
      updates.name = name;
    }

    if ('filterJson' in body) {
      const filterJson =
        body.filterJson !== null &&
        typeof body.filterJson === 'object' &&
        !Array.isArray(body.filterJson)
          ? (body.filterJson as Record<string, unknown>)
          : null;
      if (filterJson === null) {
        res.status(400).json({ error: 'filterJson must be an object' });
        return;
      }
      updates.filterJson = filterJson;
    }

    if ('position' in body) {
      const position = Number(body.position);
      if (!Number.isInteger(position) || position < 0) {
        res.status(400).json({ error: 'position must be a non-negative integer' });
        return;
      }
      updates.position = position;
    }

    await filter.update(updates);
    res.json(filter);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'SequelizeUniqueConstraintError') {
      res.status(409).json({ error: 'DUPLICATE_NAME' });
      return;
    }
    next(err);
  }
});

// DELETE /:id — delete a saved filter
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const { user } = currentAuth(req);

    const filter = await SavedFilter.findByPk(id);
    if (!filter) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (filter.userId !== user.id) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await filter.destroy();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
