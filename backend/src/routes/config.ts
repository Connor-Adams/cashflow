import { Router } from 'express';
import * as env from '../config/env';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    logoDevToken: env.logoDevToken,
    quoteProviderConfigured: true,
    // Web-push VAPID public key (issue #651). `null` when unset — the client
    // then hides the "Enable browser alerts" control. Never expose the
    // private key here.
    vapidPublicKey: env.vapidPublicKey,
  });
});

export default router;
