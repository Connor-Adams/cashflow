import { createScopedTokenRouter } from './scopedTokens';

/** Session-authed mint/list/revoke for cfa_ audit tokens, mounted at /api/audit/tokens. */
export default createScopedTokenRouter('audit');
