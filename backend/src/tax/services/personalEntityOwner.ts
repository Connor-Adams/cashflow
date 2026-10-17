import { Op } from 'sequelize';
import { Account, Entity, HouseholdMember, User } from '../../models';

/**
 * Who a personal tax entity belongs to, and which personal entity belongs to a
 * user — answered deterministically.
 *
 * An Entity carries no user id. The tax routes used an unordered
 * `Entity.findOne({ householdId, kind: 'personal' })`, so a household with a
 * spouse entity got whichever row the database returned first, and the T1 age
 * lookup read an arbitrary HouseholdMember. The link that does exist is account
 * ownership: accounts carry both `entityId` and `ownerUserId`. A person's entity
 * is the one holding most of their accounts; ties and households with no owned
 * accounts fall back to the lowest id, so the answer never depends on row order.
 */

/** The requesting user's personal entity in this household, or null if none exists. */
export async function resolvePersonalEntity(
  householdId: number,
  userId: number,
): Promise<Entity | null> {
  const entities = await Entity.findAll({
    where: { householdId, kind: 'personal' },
    order: [['id', 'ASC']],
  });
  if (entities.length <= 1) return entities[0] ?? null;

  const owned = await Account.findAll({
    where: { entityId: { [Op.in]: entities.map((e) => e.id) }, ownerUserId: userId },
    attributes: ['entityId'],
  });
  const counts = new Map<number, number>();
  for (const a of owned) {
    if (a.entityId != null) counts.set(a.entityId, (counts.get(a.entityId) ?? 0) + 1);
  }
  let best = entities[0];
  for (const e of entities) {
    if ((counts.get(e.id) ?? 0) > (counts.get(best.id) ?? 0)) best = e;
  }
  return best;
}

/**
 * The person a personal entity is filed for: the household member owning most of
 * the entity's accounts; failing that, the household owner; failing that, the
 * earliest member.
 */
export async function resolveEntityPerson(entity: Entity): Promise<User | null> {
  const members = await HouseholdMember.findAll({
    where: { householdId: entity.householdId },
    order: [['id', 'ASC']],
  });
  if (members.length === 0) return null;
  const memberIds = new Set(members.map((m) => m.userId));

  const accounts = await Account.findAll({
    where: { entityId: entity.id, ownerUserId: { [Op.ne]: null } },
    attributes: ['ownerUserId'],
  });
  const counts = new Map<number, number>();
  for (const a of accounts) {
    if (a.ownerUserId != null && memberIds.has(a.ownerUserId)) {
      counts.set(a.ownerUserId, (counts.get(a.ownerUserId) ?? 0) + 1);
    }
  }

  let userId: number;
  if (counts.size > 0) {
    // Most accounts wins; ties go to the earlier member.
    userId = members
      .map((m) => m.userId)
      .filter((id) => counts.has(id))
      .reduce((best, id) => ((counts.get(id) ?? 0) > (counts.get(best) ?? 0) ? id : best));
  } else {
    userId = (members.find((m) => m.role === 'owner') ?? members[0]).userId;
  }
  return User.findByPk(userId);
}
