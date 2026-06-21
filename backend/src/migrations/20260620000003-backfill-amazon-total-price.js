'use strict';

/**
 * Backfill corrupted `total_price` / `subtotal` / `total` on Amazon report
 * orders imported BEFORE PR #627 (issue #629, follow-up to #557).
 *
 * Root cause (fixed forward by PR #627 in parseAmazonReportCsv.ts): the Amazon
 * "Retail.OrderHistory" data-export column "Shipment Item Subtotal" is the
 * SHIPMENT's subtotal repeated on every item row of that shipment — not a
 * per-line value. The old parser:
 *   1. wrote that shipment subtotal as each item's `total_price` (so every item
 *      in a shipment shared one inflated line total), and
 *   2. summed it per-row into the order subtotal/total (over-counting), and
 *   3. left `total = 0` / `subtotal = NULL` for orders whose CSV "Total Amount"
 *      was empty/unparseable, even though the items were priced.
 *
 * `unit_price` and `quantity` were always stored correctly — only the DERIVED
 * columns are wrong. This migration re-derives them from those stored values
 * using the exact rules the corrected parser + normalizeAmazonOrder now apply:
 *
 *   item.total_price = round2(unit_price * max(1, quantity))      [needs unit_price]
 *   order.subtotal   = round2(Σ item line totals)
 *   order.total      = round2(Σ item line totals)  ONLY when the stored total
 *                      is null or 0 (a real non-zero stored total is preserved,
 *                      matching the parser's fallback-only semantics).
 *
 * Properties:
 *   - Idempotent: re-derives from source each run; running twice is a no-op the
 *     second time because the rows already match. Never incrementally adjusts.
 *   - Guarded: only vendor='amazon' AND source='amazon_report' rows are
 *     considered, and a row is only written if its derived value actually
 *     diverges (> 0.01 for items, > 0.01 for order totals). Already-correct
 *     rows are left untouched. Items with NULL unit_price are skipped (cannot
 *     re-derive a line total — leave as-is rather than guess).
 *   - Logged: per-table affected counts go to stdout so the deploy log shows
 *     exactly what changed.
 *   - Forward-only: down() is a documented no-op. Re-deriving cannot be undone
 *     (the pre-repair corrupted values are not reconstructable and we never
 *     delete rows).
 *
 * Dual-dialect (SQLite default / Postgres in prod): uses parameterised
 * sequelize.query with `?` replacements and plain arithmetic in JS, so no
 * dialect-specific SQL. DECIMAL columns come back as strings from both dialects;
 * we Number() them and write back String()-formatted values.
 */

const CENT = 0.01;

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Sequelize DECIMAL round-trips as a string; tolerate string|number|null.
function toNum(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  async up(queryInterface) {
    const sequelize = queryInterface.sequelize;

    await sequelize.transaction(async (t) => {
      // Pull the candidate orders and their items in one pass each.
      const [orders] = await sequelize.query(
        `SELECT o.id, o.subtotal, o.total
           FROM external_orders o
          WHERE o.vendor = 'amazon' AND o.source = 'amazon_report'`,
        { transaction: t },
      );

      const orderIds = orders.map((o) => o.id);
      if (orderIds.length === 0) {
        // eslint-disable-next-line no-console
        console.log('[backfill-amazon-total-price] no amazon_report orders; nothing to do');
        return;
      }

      const [items] = await sequelize.query(
        `SELECT i.id, i.external_order_id, i.unit_price, i.total_price, i.quantity
           FROM external_order_items i
          WHERE i.external_order_id IN (${orderIds.map(() => '?').join(',')})`,
        { replacements: orderIds, transaction: t },
      );

      // Group items by order and compute the corrected per-line totals.
      const itemsByOrder = new Map();
      for (const id of orderIds) itemsByOrder.set(id, []);
      for (const it of items) {
        const list = itemsByOrder.get(it.external_order_id);
        if (list) list.push(it);
      }

      const itemUpdates = []; // { id, total }
      const orderUpdates = []; // { id, subtotal, total } (null fields => leave column)

      for (const order of orders) {
        const orderItems = itemsByOrder.get(order.id) || [];
        let lineSum = 0;
        let sumDerivable = orderItems.length > 0;

        for (const it of orderItems) {
          const unit = toNum(it.unit_price);
          if (unit === null) {
            // Can't re-derive this line total — leave it, and the order subtotal
            // can't be trusted as a full sum either.
            sumDerivable = false;
            const existingLine = toNum(it.total_price);
            if (existingLine !== null) lineSum += existingLine;
            continue;
          }
          const qty = Math.max(1, Math.round(toNum(it.quantity) || 1));
          const correctLine = round2(unit * qty);
          lineSum += correctLine;

          const currentLine = toNum(it.total_price);
          if (currentLine === null || Math.abs(currentLine - correctLine) > CENT) {
            itemUpdates.push({ id: it.id, total: correctLine });
          }
        }

        // Only rewrite order-level aggregates when every line was derivable
        // (otherwise the sum would be partial / misleading).
        if (!sumDerivable) continue;
        const correctSubtotal = round2(lineSum);

        const currentSubtotal = toNum(order.subtotal);
        const currentTotal = toNum(order.total);

        const update = { id: order.id, subtotal: null, total: null };
        let touch = false;

        if (currentSubtotal === null || Math.abs(currentSubtotal - correctSubtotal) > CENT) {
          update.subtotal = correctSubtotal;
          touch = true;
        }
        // Total: fallback to the item sum ONLY when the stored total is missing
        // or zero. A real non-zero stored total (CSV "Total Amount" with tax/
        // shipping) is intentionally preserved.
        if (currentTotal === null || currentTotal === 0) {
          if (currentTotal === null || Math.abs(currentTotal - correctSubtotal) > CENT) {
            update.total = correctSubtotal;
            touch = true;
          }
        }
        if (touch) orderUpdates.push(update);
      }

      // Apply item-line corrections.
      for (const u of itemUpdates) {
        await sequelize.query(
          'UPDATE external_order_items SET total_price = ?, updated_at = ? WHERE id = ?',
          { replacements: [String(u.total), new Date(), u.id], transaction: t },
        );
      }

      // Apply order-level corrections (only the columns that diverged).
      for (const u of orderUpdates) {
        const sets = [];
        const repl = [];
        if (u.subtotal !== null) {
          sets.push('subtotal = ?');
          repl.push(String(u.subtotal));
        }
        if (u.total !== null) {
          sets.push('total = ?');
          repl.push(String(u.total));
        }
        if (sets.length === 0) continue;
        sets.push('updated_at = ?');
        repl.push(new Date());
        repl.push(u.id);
        await sequelize.query(
          `UPDATE external_orders SET ${sets.join(', ')} WHERE id = ?`,
          { replacements: repl, transaction: t },
        );
      }

      // eslint-disable-next-line no-console
      console.log(
        `[backfill-amazon-total-price] scanned ${orders.length} amazon_report orders / ` +
          `${items.length} items; corrected ${itemUpdates.length} item line totals and ` +
          `${orderUpdates.length} order subtotal/total rows`,
      );
    });
  },

  /**
   * Forward-only. Re-deriving corrected totals cannot be reversed: the
   * pre-repair corrupted values are not reconstructable from current data, and
   * this migration never deletes rows. Intentionally a no-op so `db:migrate:undo`
   * does not fail a deploy rollback.
   */
  async down() {
    // eslint-disable-next-line no-console
    console.log(
      '[backfill-amazon-total-price] down() is a no-op: re-derivation is forward-only',
    );
  },
};
