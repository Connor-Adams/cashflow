import { Router } from 'express';
import { currentAuth } from '../auth/middleware';
import { Household } from '../models/Household';
import { Security } from '../models/Security';
import { ensureDailyPrices } from '../portfolio/backfill';

const router = Router();

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
