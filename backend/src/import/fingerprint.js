const crypto = require('crypto');

function hashContent(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function rowFingerprint({
  accountId,
  date,
  amount,
  currency,
  merchantClean,
  sourceReference,
}) {
  const payload = {
    accountId,
    date,
    amount: String(amount),
    currency: String(currency || '').toUpperCase(),
    merchantClean: String(merchantClean || ''),
    sourceReference: sourceReference || null,
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

module.exports = { hashContent, rowFingerprint };
