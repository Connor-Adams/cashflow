import { Router, type Request } from 'express';
import { Account } from '../models';
import { visibleAccountWhere } from '../auth/scope';
import { buildNetWorthAt, buildSeries } from '../networth/aggregate';

const router = Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAILY_MAX_BUCKETS = 90;
const MONTHLY_MAX_BUCKETS = 240;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function visibleAccountIds(req: Request): Promise<number[]> {
  const where = visibleAccountWhere(req);
  const accounts = await Account.findAll({ where, attributes: ['id'] });
  return accounts.map((a) => a.id);
}

router.get('/current', async (req, res, next) => {
  try {
    const asOf = (req.query.asOf as string | undefined) ?? todayIso();
    if (!DATE_RE.test(asOf)) {
      res.status(400).json({ error: 'asOf must be YYYY-MM-DD' });
      return;
    }
    if (asOf > todayIso()) {
      res.status(400).json({ error: 'asOf cannot be in the future' });
      return;
    }
    const accountIds = await visibleAccountIds(req);
    const result = await buildNetWorthAt(asOf, accountIds);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/series', async (req, res, next) => {
  try {
    const from = req.query.from as string | undefined;
    let to = req.query.to as string | undefined;
    const granularity = (req.query.granularity as string | undefined) ?? 'monthly';
    if (!from || !DATE_RE.test(from)) {
      res.status(400).json({ error: 'from must be YYYY-MM-DD' });
      return;
    }
    if (!to || !DATE_RE.test(to)) {
      res.status(400).json({ error: 'to must be YYYY-MM-DD' });
      return;
    }
    if (granularity !== 'monthly' && granularity !== 'daily') {
      res.status(400).json({ error: "granularity must be 'monthly' or 'daily'" });
      return;
    }
    const today = todayIso();
    if (to > today) to = today;

    if (granularity === 'daily') {
      const ms = new Date(to).getTime() - new Date(from).getTime();
      const days = Math.floor(ms / 86_400_000) + 1;
      if (days > DAILY_MAX_BUCKETS) {
        res.status(400).json({ error: 'daily granularity limited to 90 days; use monthly' });
        return;
      }
    } else {
      const months =
        (new Date(to).getUTCFullYear() - new Date(from).getUTCFullYear()) * 12 +
        (new Date(to).getUTCMonth() - new Date(from).getUTCMonth()) +
        1;
      if (months > MONTHLY_MAX_BUCKETS) {
        res.status(400).json({ error: 'monthly granularity limited to 240 buckets' });
        return;
      }
    }

    const accountIds = await visibleAccountIds(req);
    const result = await buildSeries(from, to, granularity, accountIds);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.patch('/accounts/:id/opening-balance', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid id' });
      return;
    }
    const account = await Account.findOne({
      where: { id, ...(visibleAccountWhere(req) as object) },
    });
    if (!account) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const { openingBalance, openingBalanceDate } = req.body as {
      openingBalance: number;
      openingBalanceDate: string | null;
    };
    if (typeof openingBalance !== 'number' || !Number.isFinite(openingBalance)) {
      res.status(400).json({ error: 'openingBalance must be a number' });
      return;
    }
    if (openingBalanceDate != null && !DATE_RE.test(openingBalanceDate)) {
      res.status(400).json({ error: 'openingBalanceDate must be YYYY-MM-DD or null' });
      return;
    }
    account.openingBalance = String(openingBalance);
    account.openingBalanceDate = openingBalanceDate;
    await account.save();
    res.json(account.toJSON());
  } catch (err) {
    next(err);
  }
});

export default router;
