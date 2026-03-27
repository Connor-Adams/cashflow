import type { Model } from 'sequelize';

type TxLike = Model | Record<string, unknown>;

function get<T = unknown>(t: TxLike, camel: string, snake: string): T | undefined {
  if (typeof (t as Model).get === 'function') {
    const v = (t as Model).get(camel as never);
    if (v !== undefined) return v as T;
  }
  const plain = t as Record<string, unknown>;
  if (camel in plain) return plain[camel] as T;
  if (snake in plain) return plain[snake] as T;
  return undefined;
}

/**
 * @param amount Transaction amount (signed).
 */
export function splitAmount(
  amount: string | number,
  finalSplitType: string,
  pctMe: string | number | null | undefined,
  pctPartner: string | number | null | undefined
): { myShareAmount: number; partnerShareAmount: number } {
  const a = Number(amount);
  if (Number.isNaN(a)) {
    return { myShareAmount: 0, partnerShareAmount: 0 };
  }
  if (finalSplitType === 'me') {
    return { myShareAmount: a, partnerShareAmount: 0 };
  }
  if (finalSplitType === 'partner') {
    return { myShareAmount: 0, partnerShareAmount: a };
  }
  let pm = pctMe != null && pctMe !== '' ? Number(pctMe) : 0.5;
  let pp = pctPartner != null && pctPartner !== '' ? Number(pctPartner) : 0.5;
  if (Number.isNaN(pm)) pm = 0.5;
  if (Number.isNaN(pp)) pp = 0.5;
  const sum = pm + pp;
  if (sum > 0) {
    pm /= sum;
    pp /= sum;
  } else {
    pm = 0.5;
    pp = 0.5;
  }
  return {
    myShareAmount: a * pm,
    partnerShareAmount: a * pp,
  };
}

/** Business amount: full signed amount when marked business, else 0. */
export function businessAmount(amount: string | number, finalBusiness: boolean): number {
  const a = Number(amount);
  if (!finalBusiness || Number.isNaN(a)) return 0;
  return a;
}

/** Apply finals + persisted share columns on a transaction instance or plain object fields. */
export function recomputeTransactionAmounts(t: TxLike): Record<string, unknown> {
  const categoryOverride = get<string | null>(t, 'categoryOverride', 'category_override');
  const autoCategory = get<string | null>(t, 'autoCategory', 'auto_category');
  const businessOverride = get<boolean | null>(t, 'businessOverride', 'business_override');
  const autoBusiness = get<boolean | null>(t, 'autoBusiness', 'auto_business');
  const splitOverride = get<string | null>(t, 'splitOverride', 'split_override');
  const autoSplitType = get<string | null>(t, 'autoSplitType', 'auto_split_type');
  const pctMeOverride = get<string | number | null>(t, 'pctMeOverride', 'pct_me_override');
  const autoPctMe = get<string | number | null>(t, 'autoPctMe', 'auto_pct_me');
  const pctPartnerOverride = get<string | number | null>(
    t,
    'pctPartnerOverride',
    'pct_partner_override'
  );
  const autoPctPartner = get<string | number | null>(
    t,
    'autoPctPartner',
    'auto_pct_partner'
  );

  const finalCategory =
    categoryOverride != null && categoryOverride !== ''
      ? categoryOverride
      : autoCategory ?? null;
  const finalBusiness =
    businessOverride != null ? Boolean(businessOverride) : Boolean(autoBusiness);
  const finalSplitType =
    splitOverride != null && splitOverride !== ''
      ? splitOverride
      : autoSplitType || 'me';
  const finalPctMe =
    pctMeOverride != null && pctMeOverride !== ''
      ? Number(pctMeOverride)
      : autoPctMe != null && autoPctMe !== ''
        ? Number(autoPctMe)
        : null;
  const finalPctPartner =
    pctPartnerOverride != null && pctPartnerOverride !== ''
      ? Number(pctPartnerOverride)
      : autoPctPartner != null && autoPctPartner !== ''
        ? Number(autoPctPartner)
        : null;

  const amount = get(t, 'amount', 'amount') as string | number | undefined;
  const { myShareAmount, partnerShareAmount } = splitAmount(
    amount ?? 0,
    finalSplitType,
    finalPctMe,
    finalPctPartner
  );
  const bus = businessAmount(amount ?? 0, finalBusiness);

  const out = {
    finalCategory,
    finalBusiness,
    finalSplitType,
    finalPctMe,
    finalPctPartner,
    myShareAmount,
    partnerShareAmount,
    businessAmount: bus,
  };

  if (typeof (t as Model).set === 'function') {
    (t as Model).set(out);
  } else {
    Object.assign(t as Record<string, unknown>, {
      final_category: finalCategory,
      final_business: finalBusiness,
      final_split_type: finalSplitType,
      final_pct_me: finalPctMe,
      final_pct_partner: finalPctPartner,
      my_share_amount: myShareAmount,
      partner_share_amount: partnerShareAmount,
      business_amount: bus,
    });
  }
  return out;
}
