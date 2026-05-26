import { defineJob } from '../registry';
import { runForwardIncomeTick } from '../../portfolio/forwardIncomeScheduler';
import * as env from '../../config/env';

defineJob({
  name: 'forward_income',
  cronDefault: env.forwardIncomeCron,
  enabledDefault: env.forwardIncomeEnabled,
  handler: async () => {
    const r = await runForwardIncomeTick();
    return { summary: { ...r } };
  },
});
