/**
 * POST /api/onboarding/initial-import — first-run onboarding (#259).
 *
 * Accepts multipart/form-data with a `file` field plus optional `accountName`
 * and `accountType` form fields. Creates an account from the dropped
 * statement (inferring name/type when possible), ingests its transactions,
 * and returns `{ accountId, importedCount, accountName, accountCreated }`.
 *
 * Failure modes return 400 with a machine-readable `code`:
 *   UNSUPPORTED_FORMAT | NO_TRANSACTIONS | PARSE_ERROR | MISSING_ACCOUNT_NAME
 *
 * Mounted at /api/onboarding behind the global requireAuth in app.ts.
 */
import { Router } from 'express';
import multer from 'multer';
import { currentAuth } from '../auth/middleware';
import { importUploadLimiter } from './importRateLimit';
import { runOnboardingImport } from '../onboarding/runOnboardingImport';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  recordAudit,
} from '../audit/log';

const ONBOARDING_FILE_MAX_BYTES = 10 * 1024 * 1024; // issue cap: < 10MB

const onboardingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ONBOARDING_FILE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!/\.(csv|ofx|qfx|pdf)$/i.test(file.originalname)) {
      const e = new Error(
        "We don't recognize this format. Supported: CSV, OFX, QIF.",
      ) as Error & { status?: number; code?: string };
      e.status = 400;
      e.code = 'UNSUPPORTED_FORMAT';
      cb(e);
      return;
    }
    cb(null, true);
  },
});

const router = Router();

router.post(
  '/initial-import',
  importUploadLimiter,
  (req, res, next) => {
    // Multer's Request type can disagree with root @types/express; runtime is fine.
    onboardingUpload.single('file')(req as never, res as never, (err: unknown) => {
      if (err) {
        // Surface the multer file-filter rejection as a coded 400 so the
        // wizard can branch on UNSUPPORTED_FORMAT just like a parse failure.
        const e = err as { message?: string; code?: string };
        if (e?.code === 'UNSUPPORTED_FORMAT') {
          res.status(400).json({
            code: 'UNSUPPORTED_FORMAT',
            error:
              e.message ??
              "We don't recognize this format. Supported: CSV, OFX, QIF.",
          });
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'Missing file field "file"' });
        return;
      }
      const { user, household } = currentAuth(req);
      const body = (req.body ?? {}) as {
        accountName?: string;
        accountType?: string;
      };

      const result = await runOnboardingImport({
        buffer: req.file.buffer,
        fileName: req.file.originalname,
        householdId: household.id,
        userId: user.id,
        accountName: body.accountName ?? null,
        accountType: body.accountType ?? null,
      });

      if (!result.ok) {
        res.status(400).json({ code: result.code, error: result.error });
        return;
      }

      await recordAudit({
        req,
        action: AUDIT_ACTIONS.ImportCommitted,
        entityType: AUDIT_ENTITY_TYPES.Import,
        entityId: result.accountId,
        summary: `Onboarding import created "${result.accountName}" with ${result.importedCount} transaction(s)`,
        metadata: {
          accountId: result.accountId,
          accountName: result.accountName,
          importedCount: result.importedCount,
          onboarding: true,
        },
      });

      res.json({
        accountId: result.accountId,
        importedCount: result.importedCount,
        accountName: result.accountName,
        accountCreated: result.accountCreated,
      });
    } catch (e) {
      next(e);
    }
  },
);

export default router;
