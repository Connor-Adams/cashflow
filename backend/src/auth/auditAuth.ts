import { requireTokenAuth } from './tokenAuth';

/** Bearer auth for the GET-only /api/audit/* surface (cfa_ tokens). */
export const requireAuditAuth = requireTokenAuth('audit');
