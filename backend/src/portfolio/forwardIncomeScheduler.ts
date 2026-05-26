import * as env from '../config/env';
import { rebuildForwardProjectionsForAllHouseholds } from './forwardIncomeBuilder';

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
  const config: ForwardIncomeTickConfig = { ...configFromEnv(), ...configOverride };
  if (!config.enabled) return { status: 'skipped_disabled' };

  try {
    const r = await rebuildForwardProjectionsForAllHouseholds();
    return {
      status: 'ran',
      householdsProcessed: r.households,
      rebuilt: r.rebuilt,
      deleted: r.deleted,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return { status: 'error', error: msg };
  }
}
