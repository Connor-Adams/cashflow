/**
 * @param {string|number} amount Transaction amount (signed).
 * @param {string} finalSplitType me | partner | shared
 * @param {string|number|null|undefined} pctMe 0–1 fraction
 * @param {string|number|null|undefined} pctPartner 0–1 fraction
 */
function splitAmount(amount, finalSplitType, pctMe, pctPartner) {
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
  let pm =
    pctMe != null && pctMe !== '' ? Number(pctMe) : 0.5;
  let pp =
    pctPartner != null && pctPartner !== '' ? Number(pctPartner) : 0.5;
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

/**
 * Business amount: full signed amount when marked business, else 0.
 * @param {string|number} amount
 * @param {boolean} finalBusiness
 */
function businessAmount(amount, finalBusiness) {
  const a = Number(amount);
  if (!finalBusiness || Number.isNaN(a)) return 0;
  return a;
}

/**
 * Apply finals + persisted share columns on a transaction instance or plain object fields.
 * @param {object} t Sequelize model or plain object with amount, overrides, auto fields
 */
function recomputeTransactionAmounts(t) {
  const categoryOverride = t.categoryOverride ?? t.category_override;
  const autoCategory = t.autoCategory ?? t.auto_category;
  const businessOverride = t.businessOverride ?? t.business_override;
  const autoBusiness = t.autoBusiness ?? t.auto_business;
  const splitOverride = t.splitOverride ?? t.split_override;
  const autoSplitType = t.autoSplitType ?? t.auto_split_type;
  const pctMeOverride = t.pctMeOverride ?? t.pct_me_override;
  const autoPctMe = t.autoPctMe ?? t.auto_pct_me;
  const pctPartnerOverride = t.pctPartnerOverride ?? t.pct_partner_override;
  const autoPctPartner = t.autoPctPartner ?? t.auto_pct_partner;

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

  const amount = t.amount;
  const { myShareAmount, partnerShareAmount } = splitAmount(
    amount,
    finalSplitType,
    finalPctMe,
    finalPctPartner
  );
  const bus = businessAmount(amount, finalBusiness);

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

  if (typeof t.set === 'function') {
    t.set(out);
  } else {
    Object.assign(t, {
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

module.exports = {
  splitAmount,
  businessAmount,
  recomputeTransactionAmounts,
};
