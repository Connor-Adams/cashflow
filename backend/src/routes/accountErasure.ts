/**
 * Right-to-erasure endpoint (issue #850).
 *
 *   DELETE /api/me/account
 *
 * Permanently deletes the caller's household and every member user, all
 * household-scoped financial data, and the on-disk receipt/vault/export files
 * those rows point at. This is the GDPR/CCPA "right to erasure" surface.
 *
 * GUARDS (both required — this is irreversible):
 *  - **Owner-gated.** Only a household member whose role is `owner` may erase
 *    the household. Members get 403. A household always has exactly one owner
 *    (see routes/household.ts), so erasure is never ambiguous.
 *  - **Explicit confirmation.** The request body must contain
 *    `{ confirm: "<household name>" }` matching the household's name exactly.
 *    A mismatch (or missing field) returns 400 and deletes nothing — this
 *    prevents an accidental or CSRF-driven destructive call from a stray
 *    DELETE with no body.
 *
 * On success the caller's session cookie is cleared (every session row was
 * already destroyed via the user cascade) and 200 is returned with a summary
 * of what was swept.
 */
import { Router } from 'express';
import { currentAuth, clearSessionCookie } from '../auth/middleware';
import { eraseHousehold } from '../household/eraseHousehold';

const router = Router();

router.delete('/account', async (req, res, next) => {
  try {
    const { household, role } = currentAuth(req);

    // Owner-gate: only the household owner may erase the household.
    if (role !== 'owner') {
      res.status(403).json({
        error: 'Only the household owner can delete the account.',
      });
      return;
    }

    // Explicit-confirmation gate: body must echo the household name exactly.
    const body = (req.body || {}) as Record<string, unknown>;
    const confirm = typeof body.confirm === 'string' ? body.confirm : '';
    if (confirm !== household.name) {
      res.status(400).json({
        error:
          'Confirmation required: send { "confirm": "<your household name>" } to permanently delete the account.',
      });
      return;
    }

    const result = await eraseHousehold(household.id);

    // Every session row for these users was destroyed in the cascade; clear the
    // caller's cookie so the browser stops sending a now-dead token.
    clearSessionCookie(res);

    res.status(200).json({
      deleted: true,
      householdId: result.householdId,
      deletedUserIds: result.deletedUserIds,
      filesSwept: result.filesSwept,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
