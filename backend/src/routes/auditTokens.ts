import { Router } from 'express';
import { Op } from 'sequelize';
import { UserAuditToken } from '../models';
import { currentAuth } from '../auth/middleware';
import { hashAuditToken, mintAuditTokenPlaintext } from '../auth/auditToken';

const router = Router();

router.post('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const label = String((req.body as { label?: unknown } | undefined)?.label ?? '').trim() || 'Audit';
    if (label.length > 64) {
      res.status(400).json({ error: 'Label must be 64 characters or fewer' });
      return;
    }
    const plaintext = mintAuditTokenPlaintext();
    const row = await UserAuditToken.create({
      userId: user.id,
      tokenHash: hashAuditToken(plaintext),
      label,
      lastUsedAt: null,
      revokedAt: null,
    });
    res.status(201).json({ id: row.id, plaintext, label: row.label, createdAt: row.createdAt });
  } catch (e) {
    next(e);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const rows = await UserAuditToken.findAll({
      where: { userId: user.id, revokedAt: { [Op.is]: null } },
      order: [['createdAt', 'DESC']],
    });
    res.json(rows.map((r) => ({ id: r.id, label: r.label, lastUsedAt: r.lastUsedAt, createdAt: r.createdAt })));
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await UserAuditToken.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Token not found' });
      return;
    }
    if (row.revokedAt == null) {
      await row.update({ revokedAt: new Date() });
    }
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
