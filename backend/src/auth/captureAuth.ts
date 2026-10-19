import { requireTokenAuth } from './tokenAuth';

/** Bearer auth for POST /api/capture/orders (cfc_ bookmarklet/extension tokens). */
export const captureAuth = requireTokenAuth('capture');
