import { Router } from 'express';
import { Op } from 'sequelize';
import { ChatThread, ChatMessage, ChatProposal, Contact } from '../models';
import { currentAuth } from '../auth/middleware';
import { runChatTurn } from '../ai/chat/loop';
import { defaultCurrency } from '../config/env';
import { writeSseHeaders, writeSseEvent } from '../ai/chat/sse';

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

// POST /api/chat/threads/:id/messages — stream a chat turn via SSE
router.post('/threads/:id/messages', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const thread = await ChatThread.findOne({ where: { id, userId: user.id } });
    if (!thread) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const b = (req.body || {}) as { message?: unknown };
    if (typeof b.message !== 'string' || b.message.trim().length === 0) {
      res.status(400).json({ error: 'message is required (non-empty string)' });
      return;
    }
    const userMessage = b.message.trim().slice(0, 20_000);

    // Per-thread rate limit + per-day token budget come in Task 14.

    // Build prompt context
    const contacts = await Contact.findAll({
      where: { householdId: household.id },
      order: [['id', 'ASC']],
    });
    const promptContext = {
      todayIso: new Date().toISOString().slice(0, 10),
      defaultCurrency,
      contacts: contacts.map((c) => {
        const j = c.toJSON() as { id: number; name: string };
        return { id: j.id, name: j.name, currency: null };
      }),
    };

    writeSseHeaders(res);
    // Wire abort: if client disconnects, abort the upstream OpenAI request.
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
      for await (const ev of runChatTurn({
        thread,
        userMessage,
        userId: user.id,
        householdId: household.id,
        promptContext,
        signal: ac.signal,
      })) {
        writeSseEvent(res, ev.type, ev);
        if (ev.type === 'assistant_done' || ev.type === 'error') {
          res.end();
          return;
        }
      }
      res.end();
    } catch (e) {
      writeSseEvent(res, 'error', { message: (e as Error).message });
      res.end();
    }
  } catch (e) {
    next(e);
  }
});

export default router;
