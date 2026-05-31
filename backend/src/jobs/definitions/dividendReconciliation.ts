import { defineJob } from '../registry';
import { Household } from '../../models';
import { autoMatchDividends } from '../../services/dividendMatcher';

defineJob({
  name: 'dividend_reconciliation',
  cronDefault: '30 3 * * *', // 3:30am nightly, after dailySnapshot
  enabledDefault: true,
  handler: async () => {
    const households = await Household.findAll({ attributes: ['id'] });
    let totalMatched = 0;
    for (const h of households) {
      const result = await autoMatchDividends(h.id);
      totalMatched += result.matched;
    }
    return { totalMatched };
  },
});
