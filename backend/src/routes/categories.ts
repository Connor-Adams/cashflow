import { Router } from 'express';
import { Op } from 'sequelize';
import { Category } from '../models';
import { householdWhere } from '../auth/scope';
import { currentAuth } from '../auth/middleware';
import { isCategoryIconName, isTaxTreatment } from '@cashflow/shared';
import { resolveCategoryPath } from '../categories/resolvePath';
import { reparentCategory } from '../categories/reparent';
import { deleteCategory } from '../categories/deleteCategory';
import { createCategory } from '../categories/createCategory';
import { CategoryError } from '../categories/errors';
import { normalizeCategoryName } from '../categories/normalizeName';
import { syncCategoryLeafNameMirrors } from '../categories/syncMirrors';
import { sequelize } from '../db';

type CategoryNode = {
  id: number;
  name: string;
  parentId: number | null;
  icon: string | null;
  taxTreatment: string;
  children: CategoryNode[];
};

function statusForCategoryError(code: CategoryError['code']): number {
  if (code === 'not_found' || code === 'parent_not_found') return 404;
  if (code === 'invalid_name') return 400;
  return 409;
}

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const rows = await Category.findAll({
      where: householdWhere(req),
      order: [['name', 'ASC']],
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.get('/tree', async (req, res, next) => {
  try {
    // categories are managed within the caller's household (consistent with the write routes)
    const rows = await Category.findAll({ where: { householdId: currentAuth(req).household.id }, order: [['name', 'ASC']] });
    const byId = new Map<number, CategoryNode>();
    for (const r of rows) {
      byId.set(r.id, {
        id: r.id,
        name: r.name,
        parentId: r.parentId,
        icon: r.icon,
        taxTreatment: r.taxTreatment,
        children: [],
      });
    }
    const roots: CategoryNode[] = [];
    for (const node of byId.values()) {
      if (node.parentId != null && byId.has(node.parentId)) {
        byId.get(node.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    res.json(roots);
  } catch (e) {
    next(e);
  }
});

router.post('/resolve-path', async (req, res, next) => {
  try {
    const path = (req.body || {}).path;
    if (typeof path !== 'string' || path.trim().length === 0) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    const { household } = currentAuth(req);
    const { leafId, createdIds } = await resolveCategoryPath(household.id, path);
    const leaf = await Category.findByPk(leafId);
    res.json({ id: leafId, name: leaf?.name ?? null, path, createdIds });
  } catch (e) {
    if (e instanceof Error && e.message === 'invalid category path') {
      res.status(400).json({ error: e.message });
      return;
    }
    next(e);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const b = (req.body || {}) as { name?: unknown; parentId?: unknown };
    if (typeof b.name !== 'string' || b.name.trim().length === 0) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const parentId = b.parentId == null ? null : Number(b.parentId);
    const { household } = currentAuth(req);
    const row = await createCategory(household.id, b.name, parentId);
    res.status(201).json(row);
  } catch (e) {
    if (e instanceof CategoryError) {
      res.status(statusForCategoryError(e.code)).json({ error: e.message, code: e.code });
      return;
    }
    next(e);
  }
});

router.patch('/:id/reparent', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const raw = (req.body || {}).parentId;
    const newParentId = raw == null ? null : Number(raw);
    const { household } = currentAuth(req);
    const row = await reparentCategory(household.id, id, newParentId);
    res.json(row);
  } catch (e) {
    if (e instanceof CategoryError) {
      res.status(statusForCategoryError(e.code)).json({ error: e.message, code: e.code });
      return;
    }
    next(e);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Category.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    const hasName = 'name' in b;
    const hasIcon = 'icon' in b;
    const hasTreatment = 'taxTreatment' in b;
    if (!hasName && !hasIcon && !hasTreatment) {
      res.status(400).json({ error: 'name, icon, or taxTreatment required' });
      return;
    }
    if (hasIcon) {
      if (b.icon === null) {
        row.set('icon', null);
      } else if (typeof b.icon === 'string' && isCategoryIconName(b.icon)) {
        row.set('icon', b.icon);
      } else {
        res.status(400).json({ error: 'unknown icon name' });
        return;
      }
    }
    if (hasTreatment) {
      if (!isTaxTreatment(b.taxTreatment)) {
        res.status(400).json({ error: 'unknown tax treatment' });
        return;
      }
      row.set('taxTreatment', b.taxTreatment);
    }
    if (hasName) {
      if (typeof b.name !== 'string' || b.name.trim().length === 0) {
        res.status(400).json({ error: 'name required' });
        return;
      }
      const newName = b.name.trim();
      const newKey = normalizeCategoryName(newName);
      const conflict = await Category.findOne({
        where: { householdId: row.householdId, parentId: row.parentId, nameKey: newKey, id: { [Op.ne]: row.id } },
      });
      if (conflict) {
        res.status(409).json({ error: `a sibling named "${newName}" already exists`, code: 'sibling_conflict' });
        return;
      }
      row.set('name', newName);
      row.set('nameKey', newKey);
      await sequelize.transaction(async (tx) => {
        await row.save({ transaction: tx });
        await syncCategoryLeafNameMirrors(row.id, newName, tx);
      });
      res.json(row);
      return;
    }
    await row.save();
    res.json(row);
  } catch (e) {
    if (e instanceof CategoryError) {
      res.status(statusForCategoryError(e.code)).json({ error: e.message, code: e.code });
      return;
    }
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { household } = currentAuth(req);
    await deleteCategory(household.id, id);
    res.status(204).end();
  } catch (e) {
    if (e instanceof CategoryError) {
      res.status(statusForCategoryError(e.code)).json({ error: e.message, code: e.code });
      return;
    }
    next(e);
  }
});

export default router;
