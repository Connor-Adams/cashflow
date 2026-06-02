import { Router } from 'express';
import { Category } from '../models';
import { householdWhere } from '../auth/scope';
import { isCategoryIconName, isTaxTreatment } from '@cashflow/shared';

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

router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Category.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    const hasIcon = 'icon' in b;
    const hasTreatment = 'taxTreatment' in b;
    if (!hasIcon && !hasTreatment) {
      res.status(400).json({ error: 'icon or taxTreatment required' });
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
    await row.save();
    res.json(row);
  } catch (e) {
    next(e);
  }
});

export default router;
