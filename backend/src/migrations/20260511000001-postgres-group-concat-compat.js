'use strict';

module.exports = {
  async up(queryInterface) {
    if (queryInterface.sequelize.getDialect() !== 'postgres') return;

    await queryInterface.sequelize.query(`
      CREATE OR REPLACE FUNCTION public.group_concat_sfunc(state text, value anyelement)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      AS $$
        SELECT CASE
          WHEN value IS NULL THEN state
          WHEN state IS NULL OR state = '' THEN value::text
          ELSE state || ',' || value::text
        END
      $$;
    `);

    await queryInterface.sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname = 'group_concat'
            AND p.prokind = 'a'
        ) THEN
          EXECUTE 'CREATE AGGREGATE public.group_concat(anyelement) (
            SFUNC = public.group_concat_sfunc,
            STYPE = text
          )';
        END IF;
      END
      $$;
    `);
  },

  async down(queryInterface) {
    if (queryInterface.sequelize.getDialect() !== 'postgres') return;

    await queryInterface.sequelize.query(
      'DROP AGGREGATE IF EXISTS public.group_concat(anyelement)'
    );
    await queryInterface.sequelize.query(
      'DROP FUNCTION IF EXISTS public.group_concat_sfunc(text, anyelement)'
    );
  },
};
