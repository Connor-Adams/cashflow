/**
 * Smart finance search router (issue #235).
 *
 * Mounts at /api/search. Routes:
 *  - GET    /api/search?q=...&limit=&offset=  → run a structured query
 *  - GET    /api/search/saved                 → list this user's saved searches
 *  - POST   /api/search/saved {name, query}   → create a saved search
 *  - PATCH  /api/search/saved/:id {name?, query?} → update
 *  - DELETE /api/search/saved/:id             → delete
 *
 * Search is rate-limited with `aiSuggestLimiter` (CodeQL flags new
 * authenticated DB routes that aren't rate limited as high severity). The
 * limiter no-ops in NODE_ENV=test.
 */

import { Router } from 'express';
import { Op, type WhereOptions } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { visibleTransactionWhere } from '../auth/scope';
import { SavedSearch, Transaction, Receipt } from '../models';
import {
  parseSearchQuery,
  type SearchIntent,
} from '../search/parseSearchQuery';
import { buildSearchWhere } from '../search/buildSearchWhere';
import { aiSuggestLimiter } from './aiRateLimit';
import { SAVED_SEARCH_NAME_MAX_LENGTH, SAVED_SEARCH_QUERY_MAX_LENGTH } from '../models/SavedSearch';

const router = Router();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function parseLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseOffset(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/** Run a structured search and return rows + total + parse feedback. */
router.get('/', aiSuggestLimiter, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const intent: SearchIntent = parseSearchQuery(q);

    if (intent.isEmpty) {
      // Helpful feedback when there's nothing to search on. We still return
      // 200 so the UI can render guidance without an error toast.
      res.json({
        intent,
        results: [],
        total: 0,
        message:
          'Type a query like `category:Groceries amount:>100 date:2026-01..03 scope:business has:receipt`.',
      });
      return;
    }

    const { where, hasReceipt } = buildSearchWhere(
      intent,
      visibleTransactionWhere(req),
    );

    // Receipt presence is handled at the route layer via an include. Using
    // an include with `required: true` forces an INNER JOIN; `required:
    // false` + `Op.is: null` on the joined column gives us the "no receipt"
    // anti-join semantic.
    const include = hasReceipt
      ? [
          {
            model: Receipt,
            as: 'receipts',
            attributes: ['id'],
            required: hasReceipt === 'has',
            where:
              hasReceipt === 'has'
                ? undefined
                : ({ id: { [Op.is]: null } } as WhereOptions),
          },
        ]
      : undefined;

    const [rows, total] = await Promise.all([
      Transaction.findAll({
        where: where as WhereOptions,
        include,
        order: [['date', 'DESC'], ['id', 'DESC']],
        limit,
        offset,
        // Required for include + limit to behave correctly with anti-join.
        subQuery: false,
      }),
      Transaction.count({
        where: where as WhereOptions,
        include: hasReceipt
          ? [
              {
                model: Receipt,
                as: 'receipts',
                attributes: [],
                required: hasReceipt === 'has',
                where:
                  hasReceipt === 'has'
                    ? undefined
                    : ({ id: { [Op.is]: null } } as WhereOptions),
              },
            ]
          : undefined,
        distinct: !!hasReceipt,
      }),
    ]);

    res.json({
      intent,
      results: rows,
      total,
      limit,
      offset,
    });
  } catch (e) {
    next(e);
  }
});

/** List the current user's saved searches. */
router.get('/saved', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const rows = await SavedSearch.findAll({
      where: { userId: user.id },
      order: [['name', 'ASC']],
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

function validateNameAndQuery(body: Record<string, unknown>): {
  ok: true;
  name: string;
  query: string;
} | { ok: false; status: number; error: string } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const query = typeof body.query === 'string' ? body.query : '';
  if (name.length === 0 || name.length > SAVED_SEARCH_NAME_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Name must be 1-${SAVED_SEARCH_NAME_MAX_LENGTH} characters`,
    };
  }
  if (query.length === 0 || query.length > SAVED_SEARCH_QUERY_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Query must be 1-${SAVED_SEARCH_QUERY_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, name, query };
}

/** Create a saved search. UNIQUE(user_id, name) — 409 on dup name. */
router.post('/saved', async (req, res, next) => {
  try {
    const validated = validateNameAndQuery((req.body || {}) as Record<string, unknown>);
    if (!validated.ok) {
      res.status(validated.status).json({ error: validated.error });
      return;
    }
    const { user } = currentAuth(req);

    // Pre-flight duplicate check so we can return 409 deterministically
    // even on dialects (sqlite) that don't surface UniqueConstraintError
    // cleanly in every test setup.
    const existing = await SavedSearch.findOne({
      where: { userId: user.id, name: validated.name },
    });
    if (existing) {
      res.status(409).json({ error: 'A saved search with that name already exists' });
      return;
    }
    const row = await SavedSearch.create({
      userId: user.id,
      name: validated.name,
      query: validated.query,
    });
    res.status(201).json(row);
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'SequelizeUniqueConstraintError') {
      res.status(409).json({ error: 'A saved search with that name already exists' });
      return;
    }
    next(e);
  }
});

/** Update an existing saved search. */
router.patch('/saved/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const { user } = currentAuth(req);
    const row = await SavedSearch.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    if ('name' in body) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length === 0 || name.length > SAVED_SEARCH_NAME_MAX_LENGTH) {
        res.status(400).json({
          error: `Name must be 1-${SAVED_SEARCH_NAME_MAX_LENGTH} characters`,
        });
        return;
      }
      row.set('name', name);
    }
    if ('query' in body) {
      const query = typeof body.query === 'string' ? body.query : '';
      if (query.length === 0 || query.length > SAVED_SEARCH_QUERY_MAX_LENGTH) {
        res.status(400).json({
          error: `Query must be 1-${SAVED_SEARCH_QUERY_MAX_LENGTH} characters`,
        });
        return;
      }
      row.set('query', query);
    }
    try {
      await row.save();
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'SequelizeUniqueConstraintError') {
        res.status(409).json({ error: 'A saved search with that name already exists' });
        return;
      }
      throw e;
    }
    res.json(row);
  } catch (e) {
    next(e);
  }
});

/** Delete a saved search. */
router.delete('/saved/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const { user } = currentAuth(req);
    const row = await SavedSearch.findOne({ where: { id, userId: user.id } });
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
