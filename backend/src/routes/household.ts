import { Router } from 'express';
import type { HouseholdSettings, HouseholdTimezoneResponse } from '@cashflow/shared';
import { currentAuth } from '../auth/middleware';
import { isHouseholdOwner } from '../auth/scope';
import { Household } from '../models/Household';
import { HouseholdMember } from '../models/HouseholdMember';
import { Security } from '../models/Security';
import { Session } from '../models/Session';
import { User } from '../models/User';
import { UserAuditToken } from '../models/UserAuditToken';
import { UserCaptureToken } from '../models/UserCaptureToken';
import { UserReportingToken } from '../models/UserReportingToken';
import { ensureDailyPrices } from '../portfolio/backfill';
import { DEFAULT_TIMEZONE } from '../time/householdToday';
import { apiReadLimiter, apiWriteLimiter } from './apiRateLimit';

const router = Router();

/** True iff `tz` is a valid IANA zone name (probed via Intl). */
function isValidIanaTimezone(tz: string): boolean {
  try {
    // Throws RangeError for an unknown zone.
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// #281 — list the active members of the caller's household. Joins
// household_members -> users so the UI can render name + email + role per row.
router.get('/members', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const members = await HouseholdMember.findAll({
      where: { householdId: household.id },
      include: [{ model: User, as: 'user' }],
      order: [['id', 'ASC']],
    });
    res.json(
      members.map((m) => {
        const user = m.get('user') as User | undefined;
        return {
          id: m.userId,
          displayName: user?.displayName ?? '',
          email: user?.email ?? '',
          role: m.role,
          joinedAt: m.createdAt,
        };
      })
    );
  } catch (err) {
    next(err);
  }
});

// #281 — remove a member from the caller's household. Owners cannot remove
// themselves (the household would be left without an owner) and the owner
// membership row is otherwise protected; both cases return 400 with a precise
// message. A user who is not a member of this household yields 404 so one
// household can never probe or mutate another's membership.
router.delete('/members/:userId', async (req, res, next) => {
  try {
    // #816 — only a household owner (or a superadmin) may evict members.
    // Without this gate any `member`-role session could remove co-members.
    if (!isHouseholdOwner(req)) {
      res.status(403).json({ error: 'Only the household owner can remove members.' });
      return;
    }
    const { user, household } = currentAuth(req);
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId)) {
      res.status(400).json({ error: 'Invalid user id' });
      return;
    }

    const member = await HouseholdMember.findOne({
      where: { householdId: household.id, userId: targetUserId },
    });
    if (!member) {
      res.status(404).json({ error: 'Member not found' });
      return;
    }

    if (member.userId === user.id && member.role === 'owner') {
      res.status(400).json({ error: "You can't revoke your own owner membership." });
      return;
    }
    if (member.role === 'owner') {
      res.status(400).json({ error: 'The household owner cannot be removed.' });
      return;
    }

    await member.destroy();

    // #852 — revoke the removed user's live credentials. Sessions and
    // capture/reporting/audit tokens are keyed by user_id only (not household);
    // `attachAuth`/`captureAuth` resolve a household via the user's first
    // remaining membership, so a stale session/token would keep authenticating
    // until natural expiry. A user holds exactly one membership in practice
    // (registration grants one; there is no multi-household join path), so
    // dropping all of the removed user's sessions and revoking all of their
    // tokens is the correct, unambiguous scope. Sessions have no revokedAt —
    // delete the rows; the token tables carry revokedAt — stamp it.
    const now = new Date();
    await Promise.all([
      Session.destroy({ where: { userId: targetUserId } }),
      UserCaptureToken.update(
        { revokedAt: now },
        { where: { userId: targetUserId, revokedAt: null } }
      ),
      UserReportingToken.update(
        { revokedAt: now },
        { where: { userId: targetUserId, revokedAt: null } }
      ),
      UserAuditToken.update(
        { revokedAt: now },
        { where: { userId: targetUserId, revokedAt: null } }
      ),
    ]);

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.patch('/benchmark', async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const { benchmarkSymbol } = req.body as { benchmarkSymbol?: string };
    if (!benchmarkSymbol || !/^[A-Za-z0-9.]{1,16}$/.test(benchmarkSymbol)) {
      res.status(400).json({ error: 'benchmarkSymbol must be 1-16 alphanumeric chars (. allowed)' });
      return;
    }
    const upper = benchmarkSymbol.toUpperCase();
    const household = await Household.findByPk(auth.household.id);
    if (!household) {
      res.status(404).json({ error: 'household not found' });
      return;
    }
    await household.update({ benchmarkSymbol: upper });

    // Lazy-create Security row + trigger backfill (non-blocking)
    const isCadListing = upper.endsWith('.TO') || upper.endsWith('.NEO') || upper.endsWith('.V');
    const [security] = await Security.findOrCreate({
      where: { householdId: household.id, symbol: upper },
      defaults: {
        householdId: household.id,
        symbol: upper,
        name: upper,
        assetType: 'etf',
        currency: isCadListing ? 'CAD' : 'USD',
      },
    });
    void ensureDailyPrices(security.id);

    res.json({ benchmarkSymbol: household.benchmarkSymbol });
  } catch (err) {
    next(err);
  }
});

// Household settings the UI can read/update. `timezone` is the IANA zone used
// for server-side "today" derivation (audit wave 3); null means the server
// falls back to DEFAULT_TIMEZONE. `effectiveTimezone` surfaces that resolved
// value so the client doesn't have to know the default.
router.get('/settings', apiReadLimiter, async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const settings: HouseholdSettings = {
      benchmarkSymbol: household.benchmarkSymbol,
      timezone: household.timezone ?? null,
      effectiveTimezone: household.timezone ?? DEFAULT_TIMEZONE,
    };
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// PATCH the household timezone. Accepts a valid IANA zone string, or null to
// clear it (server then falls back to DEFAULT_TIMEZONE).
router.patch('/timezone', apiWriteLimiter, async (req, res, next) => {
  try {
    const auth = currentAuth(req);
    const { timezone } = req.body as { timezone?: string | null };
    if (timezone !== null && typeof timezone !== 'string') {
      res.status(400).json({ error: 'timezone must be an IANA string or null' });
      return;
    }
    let value: string | null = null;
    if (typeof timezone === 'string') {
      const trimmed = timezone.trim();
      if (trimmed === '') {
        value = null;
      } else if (!isValidIanaTimezone(trimmed)) {
        res.status(400).json({ error: 'timezone must be a valid IANA zone name' });
        return;
      } else {
        value = trimmed;
      }
    }
    const household = await Household.findByPk(auth.household.id);
    if (!household) {
      res.status(404).json({ error: 'household not found' });
      return;
    }
    await household.update({ timezone: value });
    const body: HouseholdTimezoneResponse = {
      timezone: household.timezone ?? null,
      effectiveTimezone: household.timezone ?? DEFAULT_TIMEZONE,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

export default router;
