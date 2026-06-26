import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { isHouseholdOwner } from '../auth/scope';
import { HouseholdInvite } from '../models/HouseholdInvite';
import { hashToken, randomToken } from '../auth/password';

const router = Router();

// Days a freshly-minted invite stays valid. Mirrors the legacy
// `POST /api/auth/invites` handler in auth.ts so both surfaces behave the same.
const INVITE_TTL_DAYS = 14;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Shape returned for a pending invite row. The raw token is intentionally
 * NOT included — `household_invites` only stores `token_hash` (one-time
 * reveal at creation). `tokenFragment` is the first 6 chars of the hash, a
 * stable identifier the UI can show so the user can tell invites apart.
 */
function pendingView(row: HouseholdInvite) {
  return {
    id: row.id,
    tokenFragment: row.tokenHash.slice(0, 6),
    optionalEmail: row.optionalEmail ?? null,
    generatedAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

// GET /api/invites?status=pending — list pending (unaccepted, unexpired)
// invites for the caller's household. v1 only supports the pending view; any
// other `status` value still returns the pending set (documented in #281).
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const rows = await HouseholdInvite.findAll({
      where: {
        householdId: household.id,
        acceptedAt: null,
        expiresAt: { [Op.gt]: new Date() },
      },
      order: [['createdAt', 'DESC']],
    });
    res.json(rows.map(pendingView));
  } catch (e) {
    next(e);
  }
});

// POST /api/invites — create an invite scoped to the caller's household.
// Returns the raw token ONCE so the client can build the share link; the DB
// only persists the hash. Optional `optionalEmail` is record-keeping only.
router.post('/', async (req, res, next) => {
  try {
    // #816 — only a household owner (or a superadmin) may mint an invite.
    // A member-minted invite would let a low-privilege user onboard an
    // attacker-controlled account into the household.
    if (!isHouseholdOwner(req)) {
      res.status(403).json({ error: 'Only the household owner can create invites.' });
      return;
    }
    const { user, household } = currentAuth(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    let optionalEmail: string | null = null;
    if (body.optionalEmail != null && String(body.optionalEmail).trim() !== '') {
      const candidate = String(body.optionalEmail).trim();
      if (!EMAIL_RE.test(candidate)) {
        res.status(400).json({ error: 'optionalEmail must be a valid email address' });
        return;
      }
      optionalEmail = candidate;
    }

    const token = randomToken(24);
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const row = await HouseholdInvite.create({
      householdId: household.id,
      createdByUserId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      acceptedAt: null,
      acceptedByUserId: null,
      optionalEmail,
    });

    res.status(201).json({
      id: row.id,
      token,
      tokenFragment: row.tokenHash.slice(0, 6),
      optionalEmail: row.optionalEmail ?? null,
      generatedAt: row.createdAt,
      expiresAt: row.expiresAt,
    });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/invites/:id — revoke a pending invite. Scoped to the caller's
// household so one household can never revoke another's invite (404 otherwise).
router.delete('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid invite id' });
      return;
    }
    const row = await HouseholdInvite.findOne({
      where: { id, householdId: household.id },
    });
    if (!row) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }
    await row.destroy();
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

export default router;
