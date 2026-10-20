#!/usr/bin/env tsx
/**
 * Backfill ownership_contact_id on partner/shared splits.
 *
 * Import used to write ownership_type 'partner'/'shared' with
 * ownership_contact_id NULL. New imports now stamp the household's sole
 * partner Contact (contacts.is_partner) when it has exactly one; this script
 * brings existing rows in line. Households with 0 or 2+ partners are skipped
 * (ambiguous), and reported.
 *
 * The Reports / Partner Fairness balances do not change: both already
 * attribute an unstamped split to the sole partner at read time
 * (partnerMath.attributeSplitContact). The stamp makes the attribution
 * durable, so a second partner added later does not orphan these rows.
 * 'me' rows are never stamped, even when they carry a partner share.
 *
 * DRY-RUN by default — prints counts and writes nothing. Pass --apply to write
 * (one DB transaction per household, re-counted before commit).
 *
 * Prod (after this script is deployed; run inside the backend container,
 * which already has DATABASE_URL):
 *   ssh root@192.168.2.88 'C=$(docker ps --format "{{.Names}}" | grep "^cashflow-backend"); \
 *     docker exec -w /app/backend "$C" ../node_modules/.bin/tsx \
 *     scripts/backfill-partner-ownership-contact.ts [--household=1] [--apply]'
 */
import { Op } from 'sequelize';
import { Household, Transaction, sequelize } from '../src/models';
import { findSolePartnerContactId } from '../src/contacts/solePartner';

const APPLY = process.argv.includes('--apply');
const hhArg = process.argv.find((a) => a.startsWith('--household='));
const ONLY_HOUSEHOLD = hhArg ? Number(hhArg.split('=')[1]) : null;

const unstampedSplits = (householdId: number) => ({
  householdId,
  ownershipType: { [Op.in]: ['partner', 'shared'] },
  ownershipContactId: null,
});

async function main(): Promise<void> {
  const households = await Household.findAll({
    where: ONLY_HOUSEHOLD != null ? { id: ONLY_HOUSEHOLD } : {},
    attributes: ['id'],
    order: [['id', 'ASC']],
    raw: true,
  });

  let toStamp = 0;
  let skipped = 0;
  for (const { id: householdId } of households) {
    const candidates = await Transaction.count({ where: unstampedSplits(householdId) });
    if (candidates === 0) {
      console.log(`household ${householdId}: no unstamped partner/shared splits`);
      continue;
    }
    const withShare = await Transaction.count({
      where: { ...unstampedSplits(householdId), partnerShareAmount: { [Op.ne]: 0 } },
    });
    const partnerId = await findSolePartnerContactId(householdId);
    if (partnerId == null) {
      skipped += candidates;
      console.log(
        `household ${householdId}: ${candidates} unstamped splits (${withShare} with a partner share) ` +
          'SKIPPED: household has 0 or 2+ partner contacts',
      );
      continue;
    }
    toStamp += candidates;
    console.log(
      `household ${householdId}: ${candidates} unstamped splits (${withShare} with a partner share) ` +
        `-> contact ${partnerId}`,
    );
    if (!APPLY) continue;

    await sequelize.transaction(async (t) => {
      const [updated] = await Transaction.update(
        { ownershipContactId: partnerId },
        { where: unstampedSplits(householdId), transaction: t },
      );
      const remaining = await Transaction.count({
        where: unstampedSplits(householdId),
        transaction: t,
      });
      if (updated !== candidates || remaining !== 0) {
        throw new Error(
          `household ${householdId}: expected ${candidates} updates and 0 remaining, ` +
            `got ${updated} updated / ${remaining} remaining — rolled back`,
        );
      }
      console.log(`household ${householdId}: stamped ${updated} rows`);
    });
  }

  console.log(
    `${APPLY ? 'APPLIED' : 'DRY RUN'}: ${toStamp} rows ${APPLY ? 'stamped' : 'would be stamped'}, ` +
      `${skipped} skipped (ambiguous partner)` +
      (APPLY ? '' : '. Re-run with --apply to write.'),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
