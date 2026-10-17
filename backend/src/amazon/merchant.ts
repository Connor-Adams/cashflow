export function isAmazonLikeMerchant(merchant: string): boolean {
  return /\b(amazon(?:\.ca)?|amzn|amzn\s*mktp|amazon marketplace|prime)\b/i.test(merchant);
}

/**
 * The annual Amazon Prime membership charge is a subscription, never an order,
 * so no external_order can ever match it and it sits in the review queue
 * forever. Deliberately narrow: Prime Video rentals ARE orders and must keep
 * matching, so this matches the membership merchant string only — and it is a
 * separate predicate from isAmazonLikeMerchant, which also drives the +15
 * merchant bonus inside scoreAmazonOrderMatch.
 */
export function isAmazonSubscriptionCharge(merchant: string): boolean {
  return /\bprime\s*member\b/i.test(merchant);
}
