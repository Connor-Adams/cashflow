import { createScopedTokenRouter } from './scopedTokens';

/** Session-authed mint/list/revoke for cfr_ reporting tokens, mounted at /api/v1/tokens. */
export default createScopedTokenRouter('reporting');
