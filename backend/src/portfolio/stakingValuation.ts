const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
};

export function valueStakingReward(input: {
  quantity: number;
  closePrice: number;
  priceCurrency: string;
  usdCadRate: number | null;
}): { amountCad: number; pricePerUnitCad: number } | { error: string } {
  const cur = input.priceCurrency.toUpperCase();
  let perUnitCad: number;
  if (cur === 'CAD') {
    perUnitCad = input.closePrice;
  } else if (cur === 'USD') {
    if (input.usdCadRate == null) return { error: 'USD price requires usdCadRate' };
    perUnitCad = input.closePrice * input.usdCadRate;
  } else {
    return { error: `unsupported price currency ${cur}` };
  }
  return {
    amountCad: round(input.quantity * perUnitCad, 4),
    pricePerUnitCad: round(perUnitCad, 8),
  };
}
