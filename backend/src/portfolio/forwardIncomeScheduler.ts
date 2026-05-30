import { trace } from '@opentelemetry/api';
import * as env from '../config/env';
import { rebuildForwardProjectionsForAllHouseholds } from './forwardIncomeBuilder';

const tracer = trace.getTracer('cashflow-scheduler');

export interface ForwardIncomeTickResult {
  status: 'skipped_disabled' | 'ran' | 'error';
  householdsProcessed?: number;
  rebuilt?: number;
  deleted?: number;
  error?: string;
}

export interface ForwardIncomeTickConfig {
  enabled: boolean;
}

function configFromEnv(): ForwardIncomeTickConfig {
  return { enabled: env.forwardIncomeEnabled };
}

export async function runForwardIncomeTick(
  configOverride?: Partial<ForwardIncomeTickConfig>,
): Promise<ForwardIncomeTickResult> {
  return tracer.startActiveSpan('forward_income_scheduler.tick', async (span): Promise<ForwardIncomeTickResult> => {
    try {
      const config: ForwardIncomeTickConfig = { ...configFromEnv(), ...configOverride };
      if (!config.enabled) return { status: 'skipped_disabled' };

      const r = await rebuildForwardProjectionsForAllHouseholds();
      return {
        status: 'ran',
        householdsProcessed: r.households,
        rebuilt: r.rebuilt,
        deleted: r.deleted,
      };
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
