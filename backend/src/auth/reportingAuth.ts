import { requireTokenAuth } from './tokenAuth';

/** Bearer auth for the GET-only /api/v1/* reporting surface (cfr_ tokens). */
export const reportingAuth = requireTokenAuth('reporting');
