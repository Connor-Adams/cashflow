/**
 * Shared helpers used by both the read tools (tools.ts) and the mutation
 * proposal builders (proposals.ts). Lives in its own module to avoid a
 * circular dependency between tools.ts and proposals.ts (tools.ts imports
 * the builders to register the propose_* tools; proposals.ts needs the
 * same case-insensitive LIKE helper without re-importing tools.ts).
 */
import { Op } from 'sequelize';
import { sequelize } from '../../db';

/**
 * Returns an Op that does a case-insensitive substring match across dialects.
 * On Postgres we use Op.iLike (true case-insensitive). On SQLite the default
 * Op.like is case-insensitive for ASCII, so it suffices. The caller is
 * expected to wrap the substring in `%...%` themselves. The `merchant_pattern`
 * tool argument is documented as a literal substring; we do NOT escape LIKE
 * wildcards — Sequelize emits `LIKE '%x%'` without an `ESCAPE` clause, so any
 * escaping would be a misleading no-op. If a caller embeds `%` or `_`, that
 * is interpreted as part of their match expression.
 */
export function caseInsensitiveLikeOp(): typeof Op.like | typeof Op.iLike {
  return sequelize.getDialect() === 'postgres' ? Op.iLike : Op.like;
}
