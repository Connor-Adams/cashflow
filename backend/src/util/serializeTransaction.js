const { num } = require('./numbers');

function serializeTransaction(row) {
  const o = row.toJSON ? row.toJSON() : { ...row };
  for (const k of Object.keys(o)) {
    if (k.includes('_')) delete o[k];
  }
  const numericKeys = [
    'amount',
    'autoPctMe',
    'pctMeOverride',
    'finalPctMe',
    'autoPctPartner',
    'pctPartnerOverride',
    'finalPctPartner',
    'myShareAmount',
    'partnerShareAmount',
    'businessAmount',
  ];
  for (const k of numericKeys) {
    if (o[k] !== undefined && o[k] !== null) o[k] = num(o[k]);
  }
  return o;
}

module.exports = { serializeTransaction };
