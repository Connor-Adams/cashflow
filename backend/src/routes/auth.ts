import { Router } from 'express';
import { Op } from 'sequelize';
import {
  Account,
  Household,
  HouseholdInvite,
  HouseholdMember,
  ImportHistory,
  Rule,
  Session,
  Transaction,
  User,
  sequelize,
} from '../models';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../auth/password';
import { clearSessionCookie, currentAuth, setSessionCookie } from '../auth/middleware';

const router = Router();
const SESSION_DAYS = 30;

function normalizeEmail(raw: unknown): string {
  return String(raw ?? '').trim().toLowerCase();
}

function publicUser(user: User, household?: Household | null, role?: string) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    globalRole: user.globalRole,
    household: household
      ? {
          id: household.id,
          name: household.name,
          role: role ?? 'member',
        }
      : null,
  };
}

async function createSession(res: import('express').Response, userId: number) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await Session.create({ userId, tokenHash: hashToken(token), expiresAt });
  setSessionCookie(res, token, expiresAt);
}

async function resolveInvite(token: unknown) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  return HouseholdInvite.findOne({
    where: {
      tokenHash: hashToken(raw),
      acceptedAt: null,
      expiresAt: { [Op.gt]: new Date() },
    },
  });
}

router.get('/me', async (req, res, next) => {
  try {
    const userCount = await User.count();
    if (!req.auth) {
      res.json({ user: null, bootstrapRequired: userCount === 0 });
      return;
    }
    res.json({
      user: publicUser(req.auth.user, req.auth.household, req.auth.role),
      bootstrapRequired: false,
    });
  } catch (e) {
    next(e);
  }
});

router.post('/register', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const displayName = String(body.displayName ?? '').trim() || email;
    const password = String(body.password ?? '');
    if (!email || !email.includes('@')) {
      res.status(400).json({ error: 'Valid email is required' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const userCount = await User.count();
    const invite = userCount === 0 ? null : await resolveInvite(body.inviteToken);
    if (userCount > 0 && !invite) {
      res.status(403).json({ error: 'A valid household invite is required' });
      return;
    }

    const passwordData = await hashPassword(password);
    let createdUser!: User;
    let household!: Household;
    let role = 'member';
    await sequelize.transaction(async (t) => {
      createdUser = await User.create(
        {
          email,
          displayName,
          globalRole: userCount === 0 ? 'superadmin' : 'user',
          passwordHash: passwordData.hash,
          passwordSalt: passwordData.salt,
          passwordParams: passwordData.params,
        },
        { transaction: t }
      );
      if (userCount === 0) {
        household = await Household.create(
          { name: `${displayName}'s household` },
          { transaction: t }
        );
        role = 'owner';
        await HouseholdMember.create(
          { householdId: household.id, userId: createdUser.id, role },
          { transaction: t }
        );
        await Promise.all([
          Account.update(
            { householdId: household.id, ownerUserId: createdUser.id, visibility: 'private' },
            { where: { householdId: null }, transaction: t }
          ),
          Transaction.update(
            { householdId: household.id, createdByUserId: createdUser.id, visibility: 'private' },
            { where: { householdId: null }, transaction: t }
          ),
          Rule.update(
            { householdId: household.id, createdByUserId: createdUser.id },
            { where: { householdId: null }, transaction: t }
          ),
          ImportHistory.update(
            { householdId: household.id, createdByUserId: createdUser.id },
            { where: { householdId: null }, transaction: t }
          ),
        ]);
      } else {
        household = await Household.findByPk(invite!.householdId, { transaction: t }) as Household;
        await HouseholdMember.create(
          { householdId: household.id, userId: createdUser.id, role },
          { transaction: t }
        );
        await invite!.update(
          { acceptedAt: new Date(), acceptedByUserId: createdUser.id },
          { transaction: t }
        );
      }
    });

    await createSession(res, createdUser.id);
    res.status(201).json({ user: publicUser(createdUser, household, role) });
  } catch (e) {
    next(e);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const email = normalizeEmail((req.body as Record<string, unknown> | undefined)?.email);
    const password = String((req.body as Record<string, unknown> | undefined)?.password ?? '');
    const user = await User.findOne({ where: { email } });
    if (!user || !(await verifyPassword(password, user.passwordHash, user.passwordSalt))) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }
    const membership = await HouseholdMember.findOne({
      where: { userId: user.id },
      include: [{ model: Household, as: 'household' }],
      order: [['id', 'ASC']],
    });
    const household = membership?.get('household') as Household | undefined;
    if (!membership || !household) {
      res.status(403).json({ error: 'User is not linked to a household' });
      return;
    }
    await createSession(res, user.id);
    res.json({ user: publicUser(user, household, membership.role) });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    if (req.headers.cookie) {
      const token = req.headers.cookie
        .split(';')
        .map((p) => p.trim())
        .find((p) => p.startsWith('cashflow_session='))
        ?.split('=')[1];
      if (token) await Session.destroy({ where: { tokenHash: hashToken(decodeURIComponent(token)) } });
    }
    clearSessionCookie(res);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

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

export default router;
