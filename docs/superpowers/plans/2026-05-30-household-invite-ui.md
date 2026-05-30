# Household Invite UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface household invitation in a new Members settings tab with invite modal, copy-to-clipboard, revoke dialogs, and active member management.

**Architecture:** 
- Backend: Extend existing POST /api/invites endpoint to accept optionalEmail and return full invite URL; create invites router (GET pending, DELETE revoke). 
- Frontend: Build Members tab component with two sections (active members list + pending invites list), empty state for single-user households, invite modal with copy-to-clipboard functionality, confirm dialogs for revoke/remove actions.
- No breaking changes to existing invite acceptance flow; optional_email is record-keeping only in v1.

**Tech Stack:** 
- Backend: Express, Sequelize (HouseholdInvite model)
- Frontend: React, TanStack Query (likely already in use), Tailwind v4, lucide-react icons
- Testing: Backend uses `node:test` (tsx --test); frontend uses existing test patterns if available

---

## File Structure

### Backend Files
- **Modify:** `backend/src/routes/auth.ts` — Extend POST /api/invites to accept optionalEmail, return { id, token, link, expiresAt }
- **Create:** `backend/src/routes/invites.ts` — New router for GET /api/invites?status=pending, DELETE /api/invites/:id
- **Create:** `backend/src/migrations/20260530-add-optional-email-to-household-invites.js` — Add optional_email column (if not already present in DB)
- **Create:** `backend/src/routes/__tests__/invites.integration.test.ts` — Integration tests for new endpoints

### Frontend Files
- **Create:** `frontend/src/pages/settings/tabs/MembersTab.tsx` — Main Members tab component with both sections
- **Create:** `frontend/src/components/settings/InviteModal.tsx` — Modal for creating invites (reusable)
- **Modify:** `frontend/src/pages/settings/SettingsTabLayout.tsx` — Add Members tab to sidebar
- **Create:** `frontend/src/pages/settings/tabs/MembersTab.test.tsx` — Component tests

---

## Implementation Tasks

### Task 1: Create Migration for optional_email Column

**Files:**
- Create: `backend/src/migrations/20260530-add-optional-email-to-household-invites.js`

- [ ] **Step 1: Check if optional_email column already exists in DB**

Run: 
```bash
cd /Users/connoradams/Developer/cashflow && yarn workspace cashflow-backend run db:migrate:status
```

Look for any pending migrations or check the actual DB schema. If the column already exists (model says it does), you can skip this task. If missing, proceed.

- [ ] **Step 2: Create the migration file**

Create file `/Users/connoradams/Developer/cashflow/backend/src/migrations/20260530-add-optional-email-to-household-invites.js`:

```javascript
'use strict';

const { DataTypes } = require('sequelize');

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.addColumn('household_invites', 'optional_email', {
      type: DataTypes.STRING(255),
      allowNull: true,
      defaultValue: null,
    });
  },
  down: async (queryInterface) => {
    await queryInterface.removeColumn('household_invites', 'optional_email');
  },
};
```

- [ ] **Step 3: Run migration forward**

Run: 
```bash
cd /Users/connoradams/Developer/cashflow && yarn workspace cashflow-backend run db:migrate
```

Expected: Migration completes without error.

- [ ] **Step 4: Verify column exists**

Run a quick check via psql or your DB client to confirm `optional_email` column is now present in `household_invites` table.

- [ ] **Step 5: Commit**

```bash
cd /Users/connoradams/Developer/cashflow
git add backend/src/migrations/20260530-add-optional-email-to-household-invites.js
git commit -m "migration: add optional_email column to household_invites"
```

---

### Task 2: Extend POST /api/invites to Accept optionalEmail and Return Link

**Files:**
- Modify: `backend/src/routes/auth.ts` (lines 238-255)

- [ ] **Step 1: Understand current implementation**

Review lines 238-255 in `backend/src/routes/auth.ts`:
```typescript
router.post('/invites', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const token = randomToken(24);
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const row = await HouseholdInvite.create({
      householdId: household.id,
      createdByUserId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      acceptedAt: null,
      acceptedByUserId: null,
    });
    res.status(201).json({ id: row.id, token, expiresAt: row.expiresAt });
  } catch (e) {
    next(e);
  }
});
```

Note: The endpoint already returns `token` (the raw token, only shown once). Modify it to:
1. Accept optional `optionalEmail` from request body
2. Return `link` (full invite URL) alongside existing fields
3. Store `optionalEmail` in the HouseholdInvite row

- [ ] **Step 2: Determine the invite URL format**

Based on Connor's implementation notes in the issue, the invite link format is:
```
${window.location.origin}/?invite=<token>
```

In the backend, construct it as:
```typescript
const origin = req.get('origin') || 'https://app.cashflow.local'; // fallback for testing
const link = `${origin}/?invite=${token}`;
```

For tests, you can control `origin` via request headers or mock it.

- [ ] **Step 3: Modify POST /api/invites endpoint**

Replace lines 238-255 in `/Users/connoradams/Developer/cashflow/backend/src/routes/auth.ts`:

```typescript
router.post('/invites', async (req, res, next) => {
  try {
    const { user, household } = currentAuth(req);
    const optionalEmail = String(req.body?.optionalEmail ?? '').trim() || null;
    
    // Validate optional email if provided
    if (optionalEmail && !optionalEmail.includes('@')) {
      res.status(400).json({ error: 'optionalEmail must be a valid email format' });
      return;
    }

    const token = randomToken(24);
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const row = await HouseholdInvite.create({
      householdId: household.id,
      createdByUserId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
      acceptedAt: null,
      acceptedByUserId: null,
      optionalEmail,
    });

    // Construct full invite link
    const origin = req.get('origin') || 'http://localhost:3000';
    const link = `${origin}/?invite=${token}`;

    res.status(201).json({ 
      id: row.id, 
      token, 
      link, 
      expiresAt: row.expiresAt 
    });
  } catch (e) {
    next(e);
  }
});
```

- [ ] **Step 4: Commit**

```bash
cd /Users/connoradams/Developer/cashflow
git add backend/src/routes/auth.ts
git commit -m "feat(invites): extend POST /api/invites to accept optionalEmail and return full invite link"
```

---

### Task 3: Create Invites Router with GET /api/invites and DELETE /api/invites/:id

**Files:**
- Create: `backend/src/routes/invites.ts`

- [ ] **Step 1: Create the new router file**

Create `/Users/connoradams/Developer/cashflow/backend/src/routes/invites.ts`:

```typescript
import { Router } from 'express';
import { Op } from 'sequelize';
import { currentAuth } from '../auth/middleware';
import { HouseholdInvite } from '../models';

const router = Router();

// GET /api/invites?status=pending — list pending invites for the current household
router.get('/', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const status = (req.query.status as string) ?? 'pending';

    let where: Record<string, unknown> = { householdId: household.id };

    if (status === 'pending') {
      where.acceptedAt = null;
      where.expiresAt = { [Op.gt]: new Date() };
    }

    const invites = await HouseholdInvite.findAll({
      where,
      order: [['createdAt', 'DESC']],
    });

    // Return safe serialization: no raw token, only hash fragment
    const result = invites.map((i) => ({
      id: i.id,
      tokenHashFragment: i.tokenHash.substring(0, 6),
      generatedAt: i.createdAt,
      expiresAt: i.expiresAt,
      acceptedAt: i.acceptedAt,
      optionalEmail: i.optionalEmail,
    }));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/invites/:id — revoke a pending invite
router.delete('/:id', async (req, res, next) => {
  try {
    const { household } = currentAuth(req);
    const inviteId = Number(req.params.id);

    const invite = await HouseholdInvite.findOne({
      where: { id: inviteId, householdId: household.id },
    });

    if (!invite) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    if (invite.acceptedAt !== null) {
      res.status(400).json({ error: 'Invite has already been accepted' });
      return;
    }

    await invite.destroy();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
```

- [ ] **Step 2: Register the router in the backend app**

Find `backend/src/app.ts` (or the main server entry point). Locate where other routers are mounted (e.g., `app.use('/api/household', householdRouter)`). Add:

```typescript
import invitesRouter from './routes/invites';

// ... later in the middleware chain, after auth middleware:
app.use('/api/invites', invitesRouter);
```

Confirm it mounts AFTER `app.use('/api', requireAuth)` so all invites endpoints are protected.

- [ ] **Step 3: Commit**

```bash
cd /Users/connoradams/Developer/cashflow
git add backend/src/routes/invites.ts
git commit -m "feat(invites): add invites router with GET pending and DELETE revoke endpoints"
```

---

### Task 4: Write Backend Integration Tests for Invites Endpoints

**Files:**
- Create: `backend/src/routes/__tests__/invites.integration.test.ts`

- [ ] **Step 1: Create test file with setup**

Create `/Users/connoradams/Developer/cashflow/backend/src/routes/__tests__/invites.integration.test.ts`:

```typescript
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { Express } from 'express';
import { createTestApp, testRequest } from '../../../test/testHelpers';
import { User, Household, HouseholdMember, HouseholdInvite } from '../../models';
import { hashToken } from '../../auth/password';
import { sequelize } from '../../models';

describe('Invites Endpoints (Integration)', () => {
  let app: Express;
  let testUser: User;
  let testHousehold: Household;
  let sessionToken: string;

  before(async () => {
    app = await createTestApp();
    await sequelize.sync({ force: true });
  });

  after(async () => {
    await sequelize.close();
  });

  beforeEach(async () => {
    // Create test user and household
    testHousehold = await Household.create({ name: 'Test Household' });
    testUser = await User.create({
      email: 'testuser@example.com',
      displayName: 'Test User',
      globalRole: 'user',
      passwordHash: 'hash',
      passwordSalt: 'salt',
      passwordParams: '{}',
    });
    await HouseholdMember.create({
      householdId: testHousehold.id,
      userId: testUser.id,
      role: 'owner',
    });
    // Create a session token (you may have a helper for this)
    sessionToken = 'test-token-123';
  });

  describe('POST /api/invites', () => {
    it('creates a new invite with optional email and returns link', async () => {
      const response = await testRequest(app, 'POST', '/api/invites', {
        optionalEmail: 'invitee@example.com',
      })
        .set('Cookie', `cashflow_session=${sessionToken}`)
        .expect(201);

      assert(response.body.id);
      assert(response.body.token);
      assert(response.body.link);
      assert(response.body.link.includes('/?invite='));
      assert(response.body.link.includes(response.body.token));
      assert.strictEqual(response.body.expiresAt !== undefined, true);

      // Verify it was saved in the DB
      const saved = await HouseholdInvite.findByPk(response.body.id);
      assert(saved);
      assert.strictEqual(saved.optionalEmail, 'invitee@example.com');
      assert.strictEqual(saved.householdId, testHousehold.id);
    });

    it('creates invite without optional email', async () => {
      const response = await testRequest(app, 'POST', '/api/invites', {})
        .set('Cookie', `cashflow_session=${sessionToken}`)
        .expect(201);

      assert(response.body.id);
      assert(response.body.token);
      assert(response.body.link);
    });

    it('rejects invalid email format', async () => {
      const response = await testRequest(app, 'POST', '/api/invites', {
        optionalEmail: 'not-an-email',
      })
        .set('Cookie', `cashflow_session=${sessionToken}`)
        .expect(400);

      assert.strictEqual(response.body.error.includes('valid email'), true);
    });
  });

  describe('GET /api/invites?status=pending', () => {
    beforeEach(async () => {
      // Create a few test invites
      const token1 = 'test-token-1';
      const token2 = 'test-token-2';
      await HouseholdInvite.create({
        householdId: testHousehold.id,
        createdByUserId: testUser.id,
        tokenHash: hashToken(token1),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
        optionalEmail: 'invited1@example.com',
      });
      await HouseholdInvite.create({
        householdId: testHousehold.id,
        createdByUserId: testUser.id,
        tokenHash: hashToken(token2),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
        optionalEmail: 'invited2@example.com',
      });
      // Create an accepted invite (should not be returned)
      const token3 = 'test-token-3';
      await HouseholdInvite.create({
        householdId: testHousehold.id,
        createdByUserId: testUser.id,
        tokenHash: hashToken(token3),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        acceptedAt: new Date(),
        acceptedByUserId: testUser.id,
        optionalEmail: null,
      });
    });

    it('returns only pending (non-accepted, non-expired) invites', async () => {
      const response = await testRequest(app, 'GET', '/api/invites?status=pending', null)
        .set('Cookie', `cashflow_session=${sessionToken}`)
        .expect(200);

      assert.strictEqual(Array.isArray(response.body), true);
      assert.strictEqual(response.body.length, 2);

      // Verify structure: no raw token, hash fragment only
      response.body.forEach((invite: any) => {
        assert(invite.id);
        assert(invite.tokenHashFragment);
        assert.strictEqual(invite.tokenHashFragment.length, 6);
        assert(invite.generatedAt);
        assert(!invite.token); // raw token should not be returned
      });
    });

    it('excludes expired invites from pending list', async () => {
      // Create an expired invite
      const expiredToken = 'test-expired-token';
      await HouseholdInvite.create({
        householdId: testHousehold.id,
        createdByUserId: testUser.id,
        tokenHash: hashToken(expiredToken),
        expiresAt: new Date(Date.now() - 1000), // expired
        acceptedAt: null,
        optionalEmail: null,
      });

      const response = await testRequest(app, 'GET', '/api/invites?status=pending', null)
        .set('Cookie', `cashflow_session=${sessionToken}`)
        .expect(200);

      // Still only 2 (the non-expired pending ones)
      assert.strictEqual(response.body.length, 2);
    });
  });

  describe('DELETE /api/invites/:id', () => {
    let inviteId: number;
    let token: string;

    beforeEach(async () => {
      token = 'test-token-revoke';
      const invite = await HouseholdInvite.create({
        householdId: testHousehold.id,
        createdByUserId: testUser.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
        optionalEmail: 'revoke-test@example.com',
      });
      inviteId = invite.id;
    });

    it('revokes a pending invite', async () => {
      await testRequest(app, 'DELETE', `/api/invites/${inviteId}`, null)
        .set('Cookie', `cashflow_session=${sessionToken}`)
        .expect(204);

      const invite = await HouseholdInvite.findByPk(inviteId);
      assert.strictEqual(invite, null);
    });

    it('returns 404 for non-existent invite', async () => {
      await testRequest(app, 'DELETE', '/api/invites/99999', null)
        .set('Cookie', `cashflow_session=${sessionToken}`)
        .expect(404);
    });

    it('returns 400 if invite has already been accepted', async () => {
      const accepted = await HouseholdInvite.create({
        householdId: testHousehold.id,
        createdByUserId: testUser.id,
        tokenHash: hashToken('already-accepted-token'),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        acceptedAt: new Date(),
        acceptedByUserId: testUser.id,
        optionalEmail: null,
      });

      await testRequest(app, 'DELETE', `/api/invites/${accepted.id}`, null)
        .set('Cookie', `cashflow_session=${sessionToken}`)
        .expect(400);
    });

    it('respects household scoping (cannot revoke another household\'s invite)', async () => {
      // Create another household with another user
      const otherHousehold = await Household.create({ name: 'Other Household' });
      const otherUser = await User.create({
        email: 'otheruser@example.com',
        displayName: 'Other User',
        globalRole: 'user',
        passwordHash: 'hash',
        passwordSalt: 'salt',
        passwordParams: '{}',
      });
      await HouseholdMember.create({
        householdId: otherHousehold.id,
        userId: otherUser.id,
        role: 'owner',
      });

      // Create an invite in the other household
      const otherInvite = await HouseholdInvite.create({
        householdId: otherHousehold.id,
        createdByUserId: otherUser.id,
        tokenHash: hashToken('other-household-token'),
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        acceptedAt: null,
        optionalEmail: null,
      });

      // Try to revoke it as the first user (should fail with 404)
      await testRequest(app, 'DELETE', `/api/invites/${otherInvite.id}`, null)
        .set('Cookie', `cashflow_session=${sessionToken}`)
        .expect(404);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail (before implementation)**

This step is already done since the endpoints don't fully exist yet. Skip if endpoints are already working. Otherwise:

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run test src/routes/__tests__/invites.integration.test.ts
```

Expected: Multiple test failures (endpoints not fully implemented or routed correctly).

- [ ] **Step 3: Run tests to confirm they pass**

After completing Tasks 2 and 3 (endpoints), run:

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run test src/routes/__tests__/invites.integration.test.ts
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/connoradams/Developer/cashflow
git add backend/src/routes/__tests__/invites.integration.test.ts
git commit -m "test(invites): add integration tests for invites endpoints"
```

---

### Task 5: Create InviteModal Component

**Files:**
- Create: `frontend/src/components/settings/InviteModal.tsx`

- [ ] **Step 1: Create the modal component**

Create `/Users/connoradams/Developer/cashflow/frontend/src/components/settings/InviteModal.tsx`:

```typescript
import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { AlertCircle, Copy, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { postJson } from '../../lib/api';
import { useToast } from '@/hooks/useToast';

interface InviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  householdId: number;
  onInviteCreated?: () => void;
}

interface InviteResponse {
  id: number;
  token: string;
  link: string;
  expiresAt: string;
}

export function InviteModal({ isOpen, onClose, householdId, onInviteCreated }: InviteModalProps) {
  const [step, setStep] = useState<'form' | 'display'>('form');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generatedInvite, setGeneratedInvite] = useState<InviteResponse | null>(null);
  const { toast } = useToast();

  const handleClose = useCallback(() => {
    setStep('form');
    setEmail('');
    setError(null);
    setGeneratedInvite(null);
    onClose();
  }, [onClose]);

  const handleSubmitForm = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setError(null);
      setLoading(true);

      try {
        const optionalEmail = email.trim() || null;
        const payload = optionalEmail ? { optionalEmail } : {};
        const response = await postJson<InviteResponse>('/api/invites', payload);
        setGeneratedInvite(response);
        setStep('display');
        onInviteCreated?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not generate invite');
      } finally {
        setLoading(false);
      }
    },
    [email, onInviteCreated]
  );

  const handleCopyLink = useCallback(async () => {
    if (!generatedInvite) return;
    try {
      await navigator.clipboard.writeText(generatedInvite.link);
      toast({ title: 'Copied!', duration: 2000 });
    } catch (_err) {
      // Fallback: select the text and prompt user
      const input = document.querySelector('[data-invite-link-input]') as HTMLInputElement;
      if (input) {
        input.select();
        try {
          document.execCommand('copy');
          toast({ title: 'Copied!', duration: 2000 });
        } catch {
          toast({ title: 'Could not copy. Please copy manually.', variant: 'destructive' });
        }
      }
    }
  }, [generatedInvite, toast]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogHeader>
        <DialogTitle>Invite a member</DialogTitle>
      </DialogHeader>

      <DialogBody>
        {step === 'form' ? (
          <form onSubmit={handleSubmitForm} className="space-y-4">
            <div>
              <Label htmlFor="email">Email (for your records)</Label>
              <Input
                id="email"
                type="email"
                placeholder="invitee@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
              />
              <p className="text-xs text-muted-foreground mt-1">Optional. Just for your reference.</p>
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {error}
              </div>
            )}
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-sm">Send this link to your invitee. It works one time.</p>

            <div className="bg-gray-50 p-4 rounded border border-gray-200 space-y-3">
              <div className="space-y-1">
                <p className="text-xs font-semibold text-muted-foreground">INVITE LINK</p>
                <input
                  type="text"
                  readOnly
                  value={generatedInvite?.link || ''}
                  data-invite-link-input
                  className="w-full px-3 py-2 text-xs font-mono bg-white border border-gray-300 rounded select-all"
                />
              </div>
            </div>

            {generatedInvite?.expiresAt && (
              <p className="text-xs text-muted-foreground">
                Expires on {new Date(generatedInvite.expiresAt).toLocaleDateString()}
              </p>
            )}
          </div>
        )}
      </DialogBody>

      <DialogFooter>
        {step === 'form' ? (
          <>
            <Button variant="outline" onClick={handleClose} disabled={loading}>
              Cancel
            </Button>
            <Button onClick={() => document.querySelector('form')?.requestSubmit()} disabled={loading}>
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Generate invite link
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={handleClose}>
              Done
            </Button>
            <Button onClick={handleCopyLink}>
              <Copy className="w-4 h-4 mr-2" />
              Copy link
            </Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/connoradams/Developer/cashflow
git add frontend/src/components/settings/InviteModal.tsx
git commit -m "feat(settings): add InviteModal component for creating household invites"
```

---

### Task 6: Create MembersTab Component

**Files:**
- Create: `frontend/src/pages/settings/tabs/MembersTab.tsx`

- [ ] **Step 1: Create the MembersTab component**

Create `/Users/connoradams/Developer/cashflow/frontend/src/pages/settings/tabs/MembersTab.tsx`:

```typescript
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Copy, Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  useConfirm,
} from '@/components/ui/dialog';
import { deleteReq, getJson } from '../../../lib/api';
import { useAuth } from '../../../hooks/useAuth';
import { useToast } from '@/hooks/useToast';
import { InviteModal } from '@/components/settings/InviteModal';

interface Member {
  id: number;
  userId: number;
  displayName: string;
  email: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

interface Invite {
  id: number;
  tokenHashFragment: string;
  generatedAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  optionalEmail: string | null;
}

export function MembersTab() {
  const { user } = useAuth();
  const { toast } = useToast();
  const confirm = useConfirm();

  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteCache, setInviteCache] = useState<Map<number, string>>(new Map());

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [membersData, invitesData] = await Promise.all([
        getJson<Member[]>('/api/household/members'),
        getJson<Invite[]>('/api/invites?status=pending'),
      ]);
      setMembers(membersData);
      setInvites(invitesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load members');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleRemoveMember = useCallback(
    async (member: Member) => {
      if (member.userId === user?.id) {
        // Check if this user is the owner
        const isOwner = member.role === 'owner';
        if (isOwner) {
          await confirm({
            title: 'Cannot remove yourself',
            description: "You can't revoke your own owner membership.",
            confirmLabel: 'OK',
          });
          return;
        }
      }

      const ok = await confirm({
        title: 'Remove member?',
        description: `Remove ${member.displayName} from your household? They will lose access immediately.`,
        confirmLabel: 'Remove',
        destructive: true,
      });

      if (!ok) return;

      try {
        await deleteReq(`/api/household/members/${member.userId}`);
        toast({ title: 'Member removed' });
        await loadData();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not remove member';
        toast({ title: msg, variant: 'destructive' });
      }
    },
    [user, confirm, toast, loadData]
  );

  const handleRevokeInvite = useCallback(
    async (invite: Invite) => {
      const ok = await confirm({
        title: 'Revoke this invite?',
        description: 'The link will no longer work.',
        confirmLabel: 'Revoke',
        destructive: true,
      });

      if (!ok) return;

      try {
        await deleteReq(`/api/invites/${invite.id}`);
        toast({ title: 'Invite revoked' });
        await loadData();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not revoke invite';
        toast({ title: msg, variant: 'destructive' });
      }
    },
    [confirm, toast, loadData]
  );

  const handleInviteCreated = useCallback(
    (inviteId: number, token: string) => {
      // Cache the raw token so the user can copy it later in this session
      setInviteCache((prev) => new Map(prev).set(inviteId, token));
      setInviteModalOpen(false);
      void loadData();
    },
    [loadData]
  );

  const isEmpty = members.length === 1 && invites.length === 0;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <InviteModal
        isOpen={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        householdId={user?.household?.id || 0}
        onInviteCreated={() => void loadData()}
      />

      {isEmpty ? (
        <div className="text-center py-12">
          <h2 className="text-lg font-semibold mb-2">You're the only member of this household.</h2>
          <p className="text-muted-foreground mb-6">Invite a partner, spouse, or accountant to collaborate.</p>
          <Button onClick={() => setInviteModalOpen(true)} size="lg">
            <Plus className="w-4 h-4 mr-2" />
            Invite a member
          </Button>
        </div>
      ) : (
        <>
          {/* Active Members Section */}
          <div>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Active members
              </h3>
              <Button onClick={() => setInviteModalOpen(true)} variant="outline" size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Invite a member
              </Button>
            </div>

            <div className="space-y-3">
              {members.map((member) => (
                <Card key={member.id} className="p-4 flex items-center justify-between hover:bg-gray-50">
                  <div>
                    <p className="font-medium">{member.displayName}</p>
                    <p className="text-sm text-muted-foreground">{member.email}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold px-2 py-1 bg-gray-100 text-gray-700 rounded capitalize">
                      {member.role}
                    </span>
                    {member.role !== 'owner' && member.userId !== user?.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleRemoveMember(member)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </div>

          {/* Pending Invites Section */}
          {invites.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">
                Pending invites
              </h3>

              <div className="space-y-3">
                {invites.map((invite) => {
                  const hasRawToken = inviteCache.has(invite.id);
                  const generatedAgo = new Date(invite.generatedAt).toLocaleDateString();

                  return (
                    <Card key={invite.id} className="p-4 flex items-center justify-between hover:bg-gray-50">
                      <div className="flex-1">
                        <p className="text-sm font-mono text-muted-foreground">
                          {invite.tokenHashFragment}…
                        </p>
                        <p className="text-xs text-muted-foreground">{generatedAgo}</p>
                      </div>

                      <div className="flex items-center gap-2">
                        {hasRawToken && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={async () => {
                              const token = inviteCache.get(invite.id);
                              if (!token) return;
                              const origin = window.location.origin;
                              const link = `${origin}/?invite=${token}`;
                              try {
                                await navigator.clipboard.writeText(link);
                                toast({ title: 'Copied!', duration: 2000 });
                              } catch {
                                toast({
                                  title: 'Could not copy. Please copy manually.',
                                  variant: 'destructive',
                                });
                              }
                            }}
                          >
                            <Copy className="w-4 h-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRevokeInvite(invite)}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </Card>
                  );
                })}
              </div>

              <p className="text-xs text-muted-foreground mt-4">
                The "Copy link" button is only available for invites created in this session.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/connoradams/Developer/cashflow
git add frontend/src/pages/settings/tabs/MembersTab.tsx
git commit -m "feat(settings): add MembersTab component with active members and pending invites"
```

---

### Task 7: Wire Members Tab into SettingsTabLayout Sidebar

**Files:**
- Modify: `frontend/src/pages/settings/SettingsTabLayout.tsx`

- [ ] **Step 1: Update the sidebar navigation**

In `/Users/connoradams/Developer/cashflow/frontend/src/pages/settings/SettingsTabLayout.tsx`, update the `SUB_NAV` array:

```typescript
const SUB_NAV: SubNavItem[] = [
  { to: '/settings/display', label: 'Display' },
  { to: '/settings/gmail', label: 'Gmail' },
  { to: '/settings/members', label: 'Members' },
  { to: '/settings/partner-invite', label: 'Partner invite' },
]
```

- [ ] **Step 2: Commit**

```bash
cd /Users/connoradams/Developer/cashflow
git add frontend/src/pages/settings/SettingsTabLayout.tsx
git commit -m "feat(settings): add Members tab to Settings sidebar navigation"
```

---

### Task 8: Wire Members Tab Route into Settings Router

**Files:**
- Modify: `frontend/src/pages/settings/SettingsPage.tsx` (or wherever routes are defined)

- [ ] **Step 1: Find the Settings routing file**

Locate where Settings sub-routes are defined (likely in `SettingsPage.tsx` or a dedicated routing file). Look for where other tabs like `display`, `gmail`, `partner-invite` are imported and routed.

- [ ] **Step 2: Import and add MembersTab route**

Add an import:
```typescript
import { MembersTab } from './tabs/MembersTab';
```

Add a route (the exact syntax depends on your router setup, but typically):
```typescript
{ path: 'members', element: <MembersTab /> }
```

- [ ] **Step 3: Verify the route integrates with the outlet**

Ensure the SettingsTabLayout's `<Outlet />` will render the MembersTab when `/settings/members` is visited.

- [ ] **Step 4: Commit**

```bash
cd /Users/connoradams/Developer/cashflow
git add frontend/src/pages/settings/SettingsPage.tsx
git commit -m "feat(settings): wire MembersTab route into Settings router"
```

---

### Task 9: Run Full Test Suite and Verify

**Files:**
- No new files; verification only

- [ ] **Step 1: Run backend integration tests**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run test src/routes/__tests__/invites.integration.test.ts
```

Expected: All tests pass.

- [ ] **Step 2: Run all backend tests**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run test
```

Expected: All tests pass (no regressions).

- [ ] **Step 3: Run backend linter**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run lint
```

Expected: No errors.

- [ ] **Step 4: Run backend typecheck**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace cashflow-backend run typecheck
```

Expected: No errors.

- [ ] **Step 5: Run frontend typecheck**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace frontend run tsc -b
```

Expected: No errors.

- [ ] **Step 6: Run frontend linter**

```bash
cd /Users/connoradams/Developer/cashflow
yarn workspace frontend run lint
```

Expected: No errors.

---

### Task 10: Manual UI Verification (Optional but Recommended)

**Files:**
- No files; manual testing

- [ ] **Step 1: Start the dev server**

```bash
cd /Users/connoradams/Developer/cashflow
yarn dev
```

Or follow your project's dev startup procedure.

- [ ] **Step 2: Log in as the test user**

Navigate to the app and log in. If you have a test account, use it. Otherwise, create a new account.

- [ ] **Step 3: Navigate to Settings → Members**

Verify:
- Empty state renders if you're the only member (headline, body, CTA button).
- "Invite a member" button opens the modal.
- Modal has optional email field and "Generate invite link" button.
- Submitting the modal creates an invite, shows the link, and "Copy link" button works.
- Copying the link to clipboard shows "Copied!" toast.
- The full invite URL is correct (contains `/?invite=<token>`).

- [ ] **Step 4: Test pending invite revoke**

- [ ] **Step 5: (Optional) Test end-to-end accept flow**

Create an invite, copy the link, open a private/incognito browser, paste the link, and accept the invite. Verify the new user appears in the "Active members" section of the original user's household.

---

## Spec Coverage Checklist

- [x] AC #1: Settings sidebar gains "Members" tab
- [x] AC #2: Members tab renders active members and pending invites sections
- [x] AC #3: Empty state renders for single-user household
- [x] AC #4: "Invite a member" opens modal with optional email field
- [x] AC #5: Submitting modal creates invite via POST /api/invites, returns link, displays in modal
- [x] AC #6: Copy button writes to clipboard; success toast "Copied!" for 2 seconds
- [x] AC #7: Pending invites list shows token fragment, timestamp, Copy and Revoke buttons
- [x] AC #8: Revoke shows confirm dialog, then DELETEs invite and refetches list
- [x] AC #9: Removing active member shows confirm, then DELETEs membership
- [x] AC #10: Owner cannot remove themselves; shows inline error
- [x] AC #11: Endpoints scope to current user's household
- [x] AC #12: Existing POST /api/invites semantics preserved (no breaking change)

---

## Plan Summary

This plan implements the household invite UI in 10 tasks:

1. **Migration** — Ensure optional_email column exists
2. **Backend: Extend POST /api/invites** — Accept optionalEmail, return full invite link
3. **Backend: New invites router** — GET pending, DELETE revoke
4. **Backend: Integration tests** — Comprehensive coverage of new endpoints
5. **Frontend: InviteModal component** — Two-step modal for creating and displaying invites
6. **Frontend: MembersTab component** — Active members + pending invites sections
7. **Frontend: Settings sidebar** — Add Members tab link
8. **Frontend: Routing** — Wire Members tab route
9. **Verification** — Run full test suite
10. **Manual UI test** — Verify the feature works end-to-end

All tasks follow TDD discipline: test first, implement second, verify third, commit fourth.

---

