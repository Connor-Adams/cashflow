import { Router } from 'express';
import { fn, col, where as sqWhere, Op } from 'sequelize';
import { Label, TransactionLabel, sequelize } from '../models';
import { currentAuth } from '../auth/middleware';
import { householdWhere } from '../auth/scope';
import { validateLabelName, validateLabelColor } from '../labels/validate';

const router = Router();

/**
 * Builds a case-insensitive name match clause that works on both sqlite and
 * Postgres (LOWER(name) = ?). Used to enforce AC #2 in the application layer in
 * concert with the DB functional unique index.
 */
function lowerNameEq(name: string) {
  return sqWhere(fn('lower', col('name')), name.toLowerCase());
}

/**
 * Serializes a label with its usage count. Counts distinct join rows for the
 * label. Accepts a pre-computed count so the list endpoint can batch.
 */
function serializeLabel(row: Label, usageCount: number) {
  return { id: row.id, name: row.name, color: row.color ?? null, usageCount };
}

/**
 * GET /api/labels — the current household's labels with usageCount, sorted by
 * name (case-insensitive). Never returns another household's labels (AC #4).
 */
router.get('/', async (req, res, next) => {
  try {
    const rows = await Label.findAll({
      where: householdWhere(req),
      order: [['name', 'ASC']],
    });
    const ids = rows.map((r) => r.id);
    const counts = new Map<number, number>();
    if (ids.length > 0) {
      const grouped = (await TransactionLabel.findAll({
        attributes: ['labelId', [fn('COUNT', col('transaction_id')), 'cnt']],
        where: { labelId: { [Op.in]: ids } },
        group: ['label_id'],
        raw: true,
      })) as unknown as Array<{ labelId: number; cnt: string | number }>;
      for (const g of grouped) {
        counts.set(Number(g.labelId), Number(g.cnt) || 0);
      }
    }
    res.json(rows.map((r) => serializeLabel(r, counts.get(r.id) ?? 0)));
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/labels { name } — create a label for the current household.
 * 400 INVALID_LABEL_NAME on bad length/empty (AC #3); 400 DUPLICATE_LABEL when
 * a label with the same name (case-insensitive) already exists (AC #2).
 */
router.post('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const b = (req.body || {}) as Record<string, unknown>;
    const parsed = validateLabelName(b.name);
    if (!parsed.ok) {
      res.status(400).json({ error: 'INVALID_LABEL_NAME' });
      return;
    }
    const parsedColor = validateLabelColor(b.color);
    if (!parsedColor.ok) {
      res.status(400).json({ error: 'INVALID_COLOR' });
      return;
    }
    const existing = await Label.findOne({
      where: { householdId: household.id, [Op.and]: [lowerNameEq(parsed.name)] },
    });
    if (existing) {
      res.status(400).json({ error: 'DUPLICATE_LABEL' });
      return;
    }
    try {
      const row = await Label.create({
        householdId: household.id,
        name: parsed.name,
        color: parsedColor.color,
      });
      res.status(201).json(serializeLabel(row, 0));
    } catch (e) {
      // Race: the functional unique index is the authoritative backstop.
      if (isUniqueViolation(e)) {
        res.status(400).json({ error: 'DUPLICATE_LABEL' });
        return;
      }
      throw e;
    }
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/labels/:id { name } — rename. Same validation as create. A name
 * that collides (case-insensitive) with a *different* label is a 400
 * DUPLICATE_LABEL; renaming to the same name (or a case variant of itself) is
 * allowed. 404 for another household's label.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Label.findOne({ where: { id, ...householdWhere(req) } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    const parsed = validateLabelName(b.name);
    if (!parsed.ok) {
      res.status(400).json({ error: 'INVALID_LABEL_NAME' });
      return;
    }
    // Color is optional: only validate/apply when the key is present, so a
    // plain rename leaves the existing color untouched. An invalid color leaves
    // the label entirely unchanged (validated before any row mutation, AC #3).
    const colorProvided = Object.prototype.hasOwnProperty.call(b, 'color');
    let nextColor: string | null = row.color ?? null;
    if (colorProvided) {
      const parsedColor = validateLabelColor(b.color);
      if (!parsedColor.ok) {
        res.status(400).json({ error: 'INVALID_COLOR' });
        return;
      }
      nextColor = parsedColor.color;
    }
    const clash = await Label.findOne({
      where: {
        householdId: row.householdId,
        id: { [Op.ne]: row.id },
        [Op.and]: [lowerNameEq(parsed.name)],
      },
    });
    if (clash) {
      res.status(400).json({ error: 'DUPLICATE_LABEL' });
      return;
    }
    row.set('name', parsed.name);
    if (colorProvided) row.set('color', nextColor);
    try {
      await row.save();
    } catch (e) {
      if (isUniqueViolation(e)) {
        res.status(400).json({ error: 'DUPLICATE_LABEL' });
        return;
      }
      throw e;
    }
    res.json(serializeLabel(row, 0));
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/labels/:id — remove the label. FK CASCADE removes its
 * transaction_labels rows (AC #9 sibling). 404 for another household.
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const row = await Label.findOne({ where: { id, ...householdWhere(req) } });
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

/**
 * POST /api/labels/:id/merge-into/:targetId — repoint every transaction_labels
 * row from the source label to the target (skipping pairs the target already
 * has), then delete the source label (AC #8). Both labels must belong to the
 * current household. 400 when source === target.
 */
router.post('/:id/merge-into/:targetId', async (req, res, next) => {
  try {
    const sourceId = parseInt(req.params.id, 10);
    const targetId = parseInt(req.params.targetId, 10);
    if (!Number.isInteger(sourceId) || !Number.isInteger(targetId)) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    if (sourceId === targetId) {
      res.status(400).json({ error: 'Cannot merge a label into itself' });
      return;
    }
    const scope = householdWhere(req);
    const [source, target] = await Promise.all([
      Label.findOne({ where: { id: sourceId, ...scope } }),
      Label.findOne({ where: { id: targetId, ...scope } }),
    ]);
    if (!source || !target) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    await sequelize.transaction(async (t) => {
      // Conflict-skip: only repoint rows whose (target, txn) pair does not
      // already exist, so the composite PK is never violated. Run as one
      // UPDATE with a NOT EXISTS guard, then delete the leftovers (txns the
      // target already had), then delete the source label.
      await sequelize.query(
        `UPDATE transaction_labels
         SET label_id = :targetId
         WHERE label_id = :sourceId
           AND transaction_id NOT IN (
             SELECT transaction_id FROM transaction_labels WHERE label_id = :targetId
           )`,
        { replacements: { sourceId, targetId }, transaction: t },
      );
      // Any source rows that survived collided with an existing target pair;
      // drop them so the source delete cascade has nothing left to carry.
      await TransactionLabel.destroy({ where: { labelId: sourceId }, transaction: t });
      await source.destroy({ transaction: t });
    });
    res.json({ merged: true, sourceId, targetId });
  } catch (e) {
    next(e);
  }
});

/**
 * Cross-dialect unique-constraint violation detector. sqlite reports
 * "SQLITE_CONSTRAINT", Postgres "23505"; Sequelize also wraps both as
 * UniqueConstraintError (name).
 */
function isUniqueViolation(e: unknown): boolean {
  const err = e as { name?: string; original?: { code?: string }; parent?: { code?: string } };
  if (err?.name === 'SequelizeUniqueConstraintError') return true;
  const code = err?.original?.code ?? err?.parent?.code;
  return code === '23505' || code === 'SQLITE_CONSTRAINT';
}

export default router;
