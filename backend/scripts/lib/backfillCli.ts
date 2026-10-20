/**
 * The shared tail of the transfer backfill CLIs: run the write as a `system`
 * revision, and turn a BackfillAborted into a one-line exit 1.
 */
import { sequelize } from '../../src/models';
import { BackfillAborted } from '../../src/transfers/backfillHalfLinkedCsvTransfers';
import { withRevisionContext } from '../../src/util/transactionRevisions';

export function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return withRevisionContext({ source: 'system', changedByUserId: null }, fn);
}

export function runBackfillCli(main: () => Promise<void>): void {
  main()
    .catch((err) => {
      console.error(err instanceof BackfillAborted ? `Aborted: ${err.message}` : err);
      process.exitCode = 1;
    })
    .finally(() => sequelize.close());
}
