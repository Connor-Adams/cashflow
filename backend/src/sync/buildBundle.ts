/**
 * buildBundle — assemble the per-household payload that goes into a
 * passphrase-encrypted backup bundle (Cashflow #239).
 *
 * Reads each table in the V1 set via Sequelize raw query (scoped to
 * the source household_id) and packages the rows into a plain JSON
 * payload. The codec in bundleFormat.ts then wraps it with PBKDF2 +
 * AES-256-GCM.
 */
import { QueryTypes, type Sequelize } from 'sequelize';
import { BUNDLE_SCHEMA_VERSION, type BundlePayload } from './bundleFormat';
import { TABLES } from './tables';

export interface BuildBundleOptions {
  /** The household whose rows should be exported. */
  householdId: number;
  /** Human-readable origin label written into the bundle metadata. */
  origin: string;
}

/**
 * Dump the household's rows into an unencrypted BundlePayload.
 *
 * The payload is plaintext — the caller is expected to immediately
 * pass it through bundleFormat.encryptBundle() with a user-supplied
 * passphrase. We never return the unencrypted payload over the wire.
 */
export async function buildBundle(
  sequelize: Sequelize,
  options: BuildBundleOptions,
): Promise<BundlePayload> {
  const { householdId, origin } = options;
  if (!Number.isInteger(householdId) || householdId < 1) {
    throw new Error('buildBundle requires a positive integer householdId');
  }

  const tables: Record<string, unknown[]> = {};
  for (const spec of TABLES) {
    const cols = spec.columns.map((c) => `"${c}"`).join(', ');
    const rows = await sequelize.query<Record<string, unknown>>(
      `SELECT ${cols} FROM "${spec.table}" WHERE "household_id" = :hid`,
      {
        replacements: { hid: householdId },
        type: QueryTypes.SELECT,
      },
    );
    tables[spec.table] = rows;
  }

  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    origin,
    sourceHouseholdId: householdId,
    tables,
  };
}
