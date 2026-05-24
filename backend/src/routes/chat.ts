import { Router } from 'express';
import { Op } from 'sequelize';
import { ChatThread, ChatMessage, ChatProposal } from '../models';
import { currentAuth } from '../auth/middleware';

const router = Router();

function parseId(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// GET /api/chat/threads — list non-archived threads for current user
router.get('/threads', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const threads = await ChatThread.findAll({
      where: { userId: user.id, archivedAt: { [Op.is]: null } },
      order: [
        ['lastMessageAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: 200,
    });
    res.json(threads.map((t) => t.toJSON()));
  } catch (e) {
    next(e);
  }
});

// POST /api/chat/threads — create a new thread (title optional)
router.post('/threads', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const b = (req.body || {}) as { title?: unknown };
    const title =
      typeof b.title === 'string' && b.title.trim().length > 0
        ? b.title.trim().slice(0, 256)
        : null;
    const row = await ChatThread.create({
      userId: user.id,
      title,
      archivedAt: null,
      lastMessageAt: null,
    });
    res.status(201).json(row.toJSON());
  } catch (e) {
    next(e);
  }
});

// GET /api/chat/threads/:id — one thread with its messages
router.get('/threads/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const thread = await ChatThread.findOne({
      where: { id, userId: user.id },
    });
    if (!thread) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const messages = await ChatMessage.findAll({
      where: { threadId: id },
      order: [['id', 'ASC']],
    });
    const proposals = await ChatProposal.findAll({
      where: { threadId: id },
      order: [['id', 'ASC']],
    });
    res.json({
      thread: thread.toJSON(),
      messages: messages.map((m) => m.toJSON()),
      proposals: proposals.map((p) => p.toJSON()),
    });
  } catch (e) {
    next(e);
  }
});

// PATCH /api/chat/threads/:id — rename / archive / unarchive
router.patch('/threads/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const row = await ChatThread.findOne({ where: { id, userId: user.id } });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(b, 'title')) {
      const t = b.title;
      if (t == null) {
        row.set('title', null);
      } else if (typeof t === 'string') {
        row.set('title', t.trim().slice(0, 256));
      } else {
        res.status(400).json({ error: 'title must be string or null' });
        return;
      }
    }
    if (Object.prototype.hasOwnProperty.call(b, 'archived')) {
      const a = b.archived;
      if (typeof a !== 'boolean') {
        res.status(400).json({ error: 'archived must be boolean' });
        return;
      }
      row.set('archivedAt', a ? new Date() : null);
    }
    await row.save();
    res.json(row.toJSON());
  } catch (e) {
    next(e);
  }
});

// DELETE /api/chat/threads/:id — hard delete (FKs cascade)
router.delete('/threads/:id', async (req, res, next) => {
  try {
    const { user } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const row = await ChatThread.findOne({ where: { id, userId: user.id } });
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

// POST /api/chat/threads/:id/messages — placeholder until Task 11
router.post('/threads/:id/messages', (_req, res) => {
  res.status(501).json({ error: 'chat loop not yet implemented (Task 11)' });
});

export default router;
