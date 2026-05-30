/**
 * Saved filter presets router (issue #272).
 *
 * Mounts at /api/saved-filters. Routes:
 *  - GET    /api/saved-filters?page=transactions → list this user's presets for a page
 *  - POST   /api/saved-filters {name, page, filterJson} → create a preset
 *  - PATCH  /api/saved-filters/:id {name?, filterJson?, position?} → update
 *  - DELETE /api/saved-filters/:id → delete (204)
 */

import { Router } from 'express';
import { Op, UniqueConstraintError } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { SavedFilter } from '../models';
import { SAVED_FILTER_NAME_MAX_LENGTH } from '../models/SavedFilter';

const router = Router();

/** Pages that support saved filters (v1). */
const KNOWN_PAGES = ['transactions'] as const;
type KnownPage = (typeof KNOWN_PAGES)[number];

function isKnownPage(v: unknown): v is KnownPage {
  return KNOWN_PAGES.includes(v as KnownPage);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** List the current user's saved filters for a given page. */
router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const page = req.query.page;
    if (!isKnownPage(page)) {
      res.json([]);
      return;
    }
    const rows = await SavedFilter.findAll({
      where: { userId: user.id, page },
      order: [
        ['position', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

/** Create a saved filter. */
router.post('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length === 0 || name.length > SAVED_FILTER_NAME_MAX_LENGTH) {
      res.status(400).json({ error: 'INVALID_NAME' });
      return;
    }

    if (!isKnownPage(body.page)) {
      res.status(400).json({ error: 'INVALID_PAGE' });
      return;
    }
    const page = body.page;

    if (!isPlainObject(body.filterJson)) {
      res.status(400).json({ error: 'INVALID_FILTER_JSON' });
      return;
    }

    try {
      const row = await SavedFilter.create({
        userId: user.id,
        name,
        page,
        filterJson: body.filterJson,
        position: 0,
      });
      res.status(201).json(row);
    } catch (e) {
      if (e instanceof UniqueConstraintError) {
        res.status(400).json({ error: 'DUPLICATE_NAME' });
        return;
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

/** Update an existing saved filter (name, filterJson, or position). */
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { user } = currentAuth(req);
    const row = await SavedFilter.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;

    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length === 0 || name.length > SAVED_FILTER_NAME_MAX_LENGTH) {
        res.status(400).json({ error: 'INVALID_NAME' });
        return;
      }
      row.set('name', name);
    }

    if ('filterJson' in body) {
      if (!isPlainObject(body.filterJson)) {
        res.status(400).json({ error: 'INVALID_FILTER_JSON' });
        return;
      }
      row.set('filterJson', body.filterJson);
    }

    if ('position' in body) {
      const pos = Number(body.position);
      if (!Number.isFinite(pos)) {
        res.status(400).json({ error: 'INVALID_POSITION' });
        return;
      }
      row.set('position', Math.round(pos));
    }

    try {
      await row.save();
    } catch (e) {
      if (e instanceof UniqueConstraintError) {
        res.status(400).json({ error: 'DUPLICATE_NAME' });
        return;
      }
      throw e;
    }

    res.json(row);
  } catch (e) {
    next(e);
  }
});

/** Delete a saved filter. */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const { user } = currentAuth(req);
    const row = await SavedFilter.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await row.destroy();
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
