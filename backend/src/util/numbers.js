/**
 * SQLite DECIMAL values often arrive as strings on reads.
 * @param {unknown} v
 */
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

module.exports = { num };
