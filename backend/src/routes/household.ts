import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { Household } from '../models/Household';
import { HouseholdMember } from '../models/HouseholdMember';
import { Security } from '../models/Security';
import { User } from '../models/User';
import { ensureDailyPrices } from '../portfolio/backfill';

const router = Router();

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

export default router;
