import { Router } from 'express';
import * as env from '../config/env';
import { isPushConfigured } from '../notifications/webPush';
import { isEmailConfigured } from '../notifications/mailer';

const router = Router();

router.get('/', (_req, res) => {
  res.json({
    logoDevToken: env.logoDevToken,
    quoteProviderConfigured: true,
    // Web-push VAPID public key (issue #651). `null` unless push is fully
    // configured (public AND private key) — a public key alone would let the
    // browser subscribe while every server-side send no-ops. The client reads
    // `null` as "push unavailable on this server". Never expose the private
    // key here.
    vapidPublicKey: isPushConfigured() ? env.vapidPublicKey : null,
    // Whether the mailer driver can deliver (false on the noop driver). A
    // boolean only — SMTP host/user/credentials never leave the server.
    emailConfigured: isEmailConfigured(),
  });
});

export default router;
