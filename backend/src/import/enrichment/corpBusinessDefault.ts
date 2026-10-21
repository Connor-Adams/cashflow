/**
 * The automatic business flag a row on a given account should carry.
 *
 * Every signal that sets `autoBusiness` is a household-wide guess when the row
 * sits on a corporation's account: merchant memory learned it from the
 * household's other rows, the AI prompt defaults spending to `business=false`
 * and sees no account or entity, an embedding match copies a neighbour's flag,
 * and a rule's `is_business` defaults to false whether or not anyone decided.
 * On an account owned by a corporation the money IS the business's, so the
 * guess is wrong by construction — and the nightly backfill wrote it over the
 * import-time flag every night (prod: 139 system true→false flips on corp rows,
 * 28 of the 29 Wise client receipts among them).
 *
 * So on a corp account the automatic flag is true. A person who wants one corp
 * row treated as non-business sets that row's `businessOverride`, which still
 * wins downstream (calculateShares: `finalBusiness = businessOverride ?? autoBusiness`).
 */
export function businessForAccount(autoBusiness: boolean | null, accountIsCorp: boolean): boolean | null {
  return accountIsCorp ? true : autoBusiness;
}
