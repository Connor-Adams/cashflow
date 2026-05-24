import { sequelize } from '../models';

function isPostgres(): boolean {
  return sequelize.getDialect() === 'postgres';
}

/**
 * Cross-dialect JSON field text extraction.
 * Postgres: `column ->> 'key'`. SQLite: `json_extract(column, '$.key')`.
 * `key` must be a safe identifier (no quotes); callers are expected to pass literals.
 */
export function jsonExtractText(column: string, key: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(key)) {
    throw new Error(`Unsafe JSON key: ${key}`);
  }
  return isPostgres()
    ? `${column} ->> '${key}'`
    : `json_extract(${column}, '$.${key}')`;
}

/**
 * Cross-dialect string aggregation across a GROUP BY.
 * Postgres: `STRING_AGG(column::text, ',')`. SQLite: `GROUP_CONCAT(column)`.
 */
export function groupConcat(column: string): string {
  return isPostgres()
    ? `STRING_AGG(${column}::text, ',')`
    : `GROUP_CONCAT(${column})`;
}
