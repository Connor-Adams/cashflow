/**
 * Fans the insight detectors out across every household.
 *
 * `runDetectorsForHousehold` is per-household, so the scheduled job needs a
 * wrapper that iterates. Failures are isolated per household: one bad row
 * must not stop the remaining households from getting fresh insights.
 */
import { Household } from '../models';
import { logger } from '../observability/logger';
import { runDetectorsForHousehold } from './runDetectors';

export interface AllHouseholdDetectorsResult {
  households: number;
  succeeded: number;
  failed: number;
  created: number;
  refreshed: number;
  errors: Array<{ householdId: number; message: string }>;
}

export async function runAllHouseholdDetectors(options?: {
  now?: Date;
  /** Test seam — defaults to the real per-household runner. */
  runForHousehold?: typeof runDetectorsForHousehold;
}): Promise<AllHouseholdDetectorsResult> {
  const now = options?.now ?? new Date();
  const runOne = options?.runForHousehold ?? runDetectorsForHousehold;

  const households = await Household.findAll({ attributes: ['id'], raw: true });

  const result: AllHouseholdDetectorsResult = {
    households: households.length,
    succeeded: 0,
    failed: 0,
    created: 0,
    refreshed: 0,
    errors: [],
  };

  for (const row of households as unknown as Array<{ id: number }>) {
    try {
      const one = await runOne(row.id, { now });
      result.succeeded += 1;
      result.created += one.created;
      result.refreshed += one.refreshed;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.failed += 1;
      result.errors.push({ householdId: row.id, message });
      logger.warn(
        { householdId: row.id, err: message },
        'insight_detectors_household_failed',
      );
    }
  }

  return result;
}
