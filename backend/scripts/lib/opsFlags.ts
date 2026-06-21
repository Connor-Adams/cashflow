/**
 * Shared CLI-flag helpers and safety guards for one-off ops scripts.
 *
 * All helpers are intentionally tiny and side-effect-free (except
 * `guardWriteTarget`, which logs and may exit). Import what you need.
 */
import { databaseUrl } from '../../src/config/env';

/** Parse a `--name VALUE` numeric flag from argv. Returns null if missing or non-finite. */
export function numFlag(argv: string[], name: string): number | null {
  const i = argv.indexOf(name);
  const v = i !== -1 && i < argv.length - 1 ? Number(argv[i + 1]) : null;
  return Number.isFinite(v as number) ? (v as number) : null;
}

/** Parse a `--name VALUE` string flag from argv. Returns null if missing. */
export function strFlag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i !== -1 && i < argv.length - 1 ? argv[i + 1] : null;
}

/** Returns true if `--name` is present anywhere in argv. */
export function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/**
 * Log the target DB and, if `commit` is true and DATABASE_URL is not set,
 * refuse the run by printing an error and exiting with code 1.
 *
 * Call this early in every ops script, before any DB writes.
 */
export function guardWriteTarget(commit: boolean): void {
  if (databaseUrl) {
    console.log(`Target DB: postgres (${new URL(databaseUrl).host})`);
  } else {
    console.log('Target DB: LOCAL SQLITE (no DATABASE_URL set)');
    if (commit) {
      console.error(
        'Refusing to --commit against local sqlite. Set DATABASE_URL to the prod Postgres URL ' +
          '(DATABASE_PUBLIC_URL from `railway variables --service Postgres`).',
      );
      process.exit(1);
    }
  }
}

/**
 * Sentinel thrown inside a Sequelize transaction to force a rollback on
 * dry-run without masking real errors.
 *
 * Usage:
 *   await sequelize.transaction(async (t) => {
 *     // ... do work ...
 *     if (!commit) throw new DryRunRollback();
 *   }).catch((err) => { if (!(err instanceof DryRunRollback)) throw err; });
 */
export class DryRunRollback extends Error {
  constructor() {
    super('dry-run rollback');
    this.name = 'DryRunRollback';
  }
}
