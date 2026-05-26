/**
 * Encrypted finance vault routes (issue #241).
 *
 * Endpoints:
 *  - POST   /api/vault/documents               — multipart upload
 *  - GET    /api/vault/documents               — search + filter
 *  - GET    /api/vault/documents/:id           — metadata
 *  - GET    /api/vault/documents/:id/file      — decrypted bytes
 *  - PATCH  /api/vault/documents/:id           — rename / retag / relink
 *  - DELETE /api/vault/documents/:id           — drop row + bytes
 *
 * Auth scope: rows are filtered by `visibleWhere(req)` so household members
 * see shared documents and only their own private documents. The route is
 * authenticated and DB-bound, so `aiSuggestLimiter` is applied per the
 * project's CodeQL convention for new authenticated endpoints.
 */
import { Router } from 'express';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { Op, type WhereOptions } from 'sequelize';
import { VaultDocument } from '../models';
import {
  VAULT_LINKED_ENTITY_TYPES,
  VAULT_VISIBILITIES,
  type VaultEncryptionAlgorithm,
  type VaultLinkedEntityType,
  type VaultStorageKind,
  type VaultVisibility,
} from '../models/VaultDocument';
import { currentAuth } from '../auth/middleware';
import { visibleWhere } from '../auth/scope';
import { aiSuggestLimiter } from './aiRateLimit';
import {
  deleteVaultObject,
  isVaultEncryptionConfigured,
  readVaultObject,
  saveVaultObject,
} from '../storage/vaultStorage';
import {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  recordAudit,
} from '../audit/log';

const router = Router();

// Authenticated DB / IO work — rate-limit per project convention. Skips
// in NODE_ENV=test (see aiRateLimit.ts) so integration tests stay
// deterministic.
router.use(aiSuggestLimiter);

const MAX_FILE_BYTES = 25 * 1024 * 1024;

// Vault accepts a wider mime set than receipts (statements, contracts).
const ALLOWED_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'application/pdf',
  'application/zip',
  'application/json',
  'application/octet-stream',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (_req, file, cb) => {
    const mt = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_MIME.has(mt)) {
      const err = new Error(
        `Unsupported file type "${mt}". Allowed: images, PDFs, common Office docs, CSV, plain text.`,
      ) as Error & { status?: number };
      err.status = 400;
      cb(err);
      return;
    }
    cb(null, true);
  },
});

interface VaultDocumentDto {
  id: number;
  householdId: number;
  uploadedByUserId: number | null;
  visibility: VaultVisibility;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storageKind: VaultStorageKind;
  encryptionAlgorithm: VaultEncryptionAlgorithm;
  encryptionKeyVersion: number;
  tags: string[];
  linkedEntityType: VaultLinkedEntityType | null;
  linkedEntityId: number | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

function serialize(doc: VaultDocument): VaultDocumentDto {
  return {
    id: doc.id,
    householdId: doc.householdId,
    uploadedByUserId: doc.uploadedByUserId,
    visibility: doc.visibility,
    originalName: doc.originalName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    storageKind: doc.storageKind,
    encryptionAlgorithm: doc.encryptionAlgorithm,
    encryptionKeyVersion: doc.encryptionKeyVersion,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    linkedEntityType: doc.linkedEntityType,
    linkedEntityId: doc.linkedEntityId,
    description: doc.description,
    createdAt:
      doc.createdAt instanceof Date
        ? doc.createdAt.toISOString()
        : String(doc.createdAt),
    updatedAt:
      doc.updatedAt instanceof Date
        ? doc.updatedAt.toISOString()
        : String(doc.updatedAt),
  };
}

// ---- Validation helpers --------------------------------------------------

const TAG_MAX_LEN = 64;
const TAGS_MAX = 32;
const DESCRIPTION_MAX = 2000;
const ORIGINAL_NAME_MAX = 512;

function parseTags(raw: unknown):
  | { ok: true; value: string[] | undefined }
  | { ok: false; error: string } {
  if (raw == null || raw === '') return { ok: true, value: undefined };
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('[')) {
      // Allow `tags=foo,bar,baz` form too.
      candidate = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      try {
        candidate = JSON.parse(trimmed);
      } catch {
        return { ok: false, error: 'tags must be a JSON array of strings' };
      }
    }
  }
  if (!Array.isArray(candidate)) {
    return { ok: false, error: 'tags must be an array of strings' };
  }
  if (candidate.length > TAGS_MAX) {
    return { ok: false, error: `tags must contain at most ${TAGS_MAX} entries` };
  }
  const tags: string[] = [];
  for (const item of candidate) {
    if (typeof item !== 'string') {
      return { ok: false, error: 'every tag must be a string' };
    }
    const cleaned = item.trim().slice(0, TAG_MAX_LEN);
    if (cleaned.length === 0) continue;
    if (!tags.includes(cleaned)) tags.push(cleaned);
  }
  return { ok: true, value: tags };
}

function parseLinkedEntityType(
  raw: unknown,
):
  | { ok: true; value: VaultLinkedEntityType | null | undefined }
  | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  const candidate = String(raw).toLowerCase();
  if (!(VAULT_LINKED_ENTITY_TYPES as readonly string[]).includes(candidate)) {
    return {
      ok: false,
      error: `linkedEntityType must be one of: ${VAULT_LINKED_ENTITY_TYPES.join(', ')}`,
    };
  }
  return { ok: true, value: candidate as VaultLinkedEntityType };
}

function parseLinkedEntityId(
  raw: unknown,
): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: 'linkedEntityId must be a positive integer' };
  }
  return { ok: true, value: n };
}

function parseVisibility(
  raw: unknown,
): { ok: true; value: VaultVisibility | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null || raw === '') return { ok: true, value: undefined };
  const v = String(raw).toLowerCase();
  if (!(VAULT_VISIBILITIES as readonly string[]).includes(v)) {
    return {
      ok: false,
      error: `visibility must be one of: ${VAULT_VISIBILITIES.join(', ')}`,
    };
  }
  return { ok: true, value: v as VaultVisibility };
}

function tagsMatch(docTags: string[] | null, wanted: string): boolean {
  if (!Array.isArray(docTags) || docTags.length === 0) return false;
  const lc = wanted.toLowerCase();
  return docTags.some((t) => t.toLowerCase() === lc);
}

function originalNameOf(file: Express.Multer.File): string {
  return (file.originalname || 'document').slice(0, ORIGINAL_NAME_MAX);
}

// ---- POST /api/vault/documents -------------------------------------------

router.post(
  '/documents',
  (req, res, next) => {
    upload.single('file')(req as never, res as never, (err: unknown) => {
      if (err) {
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
      const auth = currentAuth(req);

      const body = (req.body ?? {}) as Record<string, unknown>;
      const tagsRes = parseTags(body.tags);
      if (!tagsRes.ok) {
        res.status(400).json({ error: tagsRes.error });
        return;
      }
      const linkedTypeRes = parseLinkedEntityType(body.linkedEntityType);
      if (!linkedTypeRes.ok) {
        res.status(400).json({ error: linkedTypeRes.error });
        return;
      }
      const linkedIdRes = parseLinkedEntityId(body.linkedEntityId);
      if (!linkedIdRes.ok) {
        res.status(400).json({ error: linkedIdRes.error });
        return;
      }
      const visRes = parseVisibility(body.visibility);
      if (!visRes.ok) {
        res.status(400).json({ error: visRes.error });
        return;
      }
      const description =
        typeof body.description === 'string'
          ? body.description.slice(0, DESCRIPTION_MAX)
          : null;

      // Generate a fresh on-disk name; we do NOT use the original name in
      // the storage path so a malicious filename can't traverse the dir.
      const ext = path.extname(req.file.originalname || '') || '';
      const safeExt = /^\.[a-zA-Z0-9]{1,8}$/.test(ext) ? ext : '';
      const stored = `${crypto.randomUUID()}${safeExt}`;
      const put = await saveVaultObject(stored, {
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        originalName: req.file.originalname || stored,
      });

      const created = await VaultDocument.create({
        householdId: auth.household.id,
        uploadedByUserId: auth.user.id,
        visibility: visRes.value ?? 'shared',
        originalName: originalNameOf(req.file),
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        storedFilename: put.storedFilename,
        storageKind: put.storageKind,
        encryptionAlgorithm: put.encryptionAlgorithm,
        encryptionKeyVersion: put.encryptionKeyVersion,
        tags: tagsRes.value ?? null,
        linkedEntityType: linkedTypeRes.value ?? null,
        linkedEntityId: linkedIdRes.value ?? null,
        description,
      });

      await recordAudit({
        req,
        action: AUDIT_ACTIONS.VaultDocumentCreated,
        entityType: AUDIT_ENTITY_TYPES.VaultDocument,
        entityId: created.id,
        summary: `Uploaded vault document "${created.originalName}"`,
        after: {
          originalName: created.originalName,
          mimeType: created.mimeType,
          sizeBytes: created.sizeBytes,
          visibility: created.visibility,
          encryptionAlgorithm: created.encryptionAlgorithm,
          linkedEntityType: created.linkedEntityType,
          linkedEntityId: created.linkedEntityId,
        },
      });

      res.status(201).json({ data: serialize(created) });
    } catch (e) {
      next(e);
    }
  },
);

// ---- GET /api/vault/documents --------------------------------------------

router.get('/documents', async (req, res, next) => {
  try {
    const where = visibleWhere(req) as WhereOptions;
    const merged: WhereOptions = { ...where };

    if (typeof req.query.linkedType === 'string' && req.query.linkedType !== '') {
      const t = parseLinkedEntityType(req.query.linkedType);
      if (!t.ok) {
        res.status(400).json({ error: t.error });
        return;
      }
      (merged as Record<string, unknown>).linkedEntityType = t.value;
    }
    if (typeof req.query.linkedId === 'string' && req.query.linkedId !== '') {
      const id = parseLinkedEntityId(req.query.linkedId);
      if (!id.ok) {
        res.status(400).json({ error: id.error });
        return;
      }
      (merged as Record<string, unknown>).linkedEntityId = id.value;
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const pattern = `%${q.toLowerCase()}%`;
      // SQLite + Postgres both implement LIKE — keep the predicate portable.
      (merged as Record<string, unknown>)[Op.and as unknown as string] = [
        {
          [Op.or]: [
            { originalName: { [Op.like]: pattern } },
            { description: { [Op.like]: pattern } },
          ],
        },
      ];
    }

    const rows = await VaultDocument.findAll({
      where: merged,
      order: [['createdAt', 'DESC']],
      limit: 500,
    });

    const tagFilter = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';
    const filtered = tagFilter
      ? rows.filter((r) => tagsMatch(r.tags, tagFilter))
      : rows;

    res.json({
      data: filtered.map(serialize),
      count: filtered.length,
      encryptionConfigured: isVaultEncryptionConfigured(),
    });
  } catch (e) {
    next(e);
  }
});

// ---- GET /api/vault/documents/:id ----------------------------------------

router.get('/documents/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await VaultDocument.findOne({
      where: { id, ...visibleWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ data: serialize(row) });
  } catch (e) {
    next(e);
  }
});

// ---- GET /api/vault/documents/:id/file -----------------------------------

router.get('/documents/:id/file', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await VaultDocument.findOne({
      where: { id, ...visibleWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const buffer = await readVaultObject(
      row.storedFilename,
      row.encryptionAlgorithm,
    );
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(row.originalName)}"`,
    );
    res.type(row.mimeType);
    res.send(buffer);
  } catch (e) {
    next(e);
  }
});

// ---- PATCH /api/vault/documents/:id --------------------------------------

router.patch('/documents/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await VaultDocument.findOne({
      where: { id, ...visibleWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<{
      originalName: string;
      visibility: VaultVisibility;
      tags: string[] | null;
      linkedEntityType: VaultLinkedEntityType | null;
      linkedEntityId: number | null;
      description: string | null;
    }> = {};

    if (Object.prototype.hasOwnProperty.call(body, 'originalName')) {
      const v = body.originalName;
      if (typeof v !== 'string' || v.trim().length === 0) {
        res.status(400).json({ error: 'originalName must be a non-empty string' });
        return;
      }
      patch.originalName = v.slice(0, ORIGINAL_NAME_MAX);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'visibility')) {
      const v = parseVisibility(body.visibility);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      if (v.value !== undefined) patch.visibility = v.value;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'tags')) {
      const r = parseTags(body.tags);
      if (!r.ok) {
        res.status(400).json({ error: r.error });
        return;
      }
      patch.tags = r.value && r.value.length > 0 ? r.value : null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'linkedEntityType')) {
      const r = parseLinkedEntityType(body.linkedEntityType);
      if (!r.ok) {
        res.status(400).json({ error: r.error });
        return;
      }
      patch.linkedEntityType = r.value ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'linkedEntityId')) {
      const r = parseLinkedEntityId(body.linkedEntityId);
      if (!r.ok) {
        res.status(400).json({ error: r.error });
        return;
      }
      patch.linkedEntityId = r.value ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      const v = body.description;
      if (v == null || v === '') patch.description = null;
      else if (typeof v === 'string') patch.description = v.slice(0, DESCRIPTION_MAX);
      else {
        res.status(400).json({ error: 'description must be string or null' });
        return;
      }
    }

    const before = {
      originalName: row.originalName,
      visibility: row.visibility,
      tags: row.tags,
      linkedEntityType: row.linkedEntityType,
      linkedEntityId: row.linkedEntityId,
      description: row.description,
    };

    await row.update(patch);

    await recordAudit({
      req,
      action: AUDIT_ACTIONS.VaultDocumentUpdated,
      entityType: AUDIT_ENTITY_TYPES.VaultDocument,
      entityId: row.id,
      summary: `Updated vault document "${row.originalName}"`,
      before,
      after: patch,
    });

    res.json({ data: serialize(row) });
  } catch (e) {
    next(e);
  }
});

// ---- DELETE /api/vault/documents/:id -------------------------------------

router.delete('/documents/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    const row = await VaultDocument.findOne({
      where: { id, ...visibleWhere(req) },
    });
    if (!row) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const before = {
      originalName: row.originalName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      visibility: row.visibility,
      linkedEntityType: row.linkedEntityType,
      linkedEntityId: row.linkedEntityId,
    };
    const storedFilename = row.storedFilename;
    await row.destroy();
    try {
      await deleteVaultObject(storedFilename);
    } catch {
      // Best-effort: row is already gone; leaving an orphan file in storage
      // is preferable to surfacing a 500 to the caller.
    }
    await recordAudit({
      req,
      action: AUDIT_ACTIONS.VaultDocumentDeleted,
      entityType: AUDIT_ENTITY_TYPES.VaultDocument,
      entityId: id,
      summary: `Deleted vault document "${before.originalName}"`,
      before,
    });
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
