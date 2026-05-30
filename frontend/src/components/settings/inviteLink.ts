/**
 * #281 — shared invite helpers, split out of InviteModal so that component
 * file only exports a component (satisfies react-refresh/only-export-components
 * and lets MembersTab import these without pulling in the modal).
 */

/**
 * Response shape of POST /api/invites. The raw `token` is returned exactly
 * once (the DB only stores its hash), so callers must capture it to build the
 * shareable link.
 */
export type CreatedInvite = {
  id: number
  token: string
  tokenFragment: string
  optionalEmail: string | null
  generatedAt: string
  expiresAt: string
}

/**
 * Build the working invite-accept URL. The accept flow is a query param on the
 * auth page (`AuthPage` reads `?invite=<token>`), NOT a `/invite/<token>`
 * path — so we mirror that to keep copied links functional end-to-end.
 */
export function buildInviteUrl(token: string): string {
  return `${window.location.origin}/?invite=${encodeURIComponent(token)}`
}
