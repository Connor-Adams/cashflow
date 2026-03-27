/**
 * @param {object[]} rulesAll All rules from DB
 * @param {string} merchantClean
 * @returns {{ rule: object|null, ambiguous: boolean }}
 */
function findBestRule(rulesAll, merchantClean) {
  const candidates = [];
  for (const rule of rulesAll) {
    const pattern = rule.merchantPattern || '';
    let ok = false;
    if (rule.matchKind === 'regex') {
      try {
        const re = new RegExp(pattern, 'i');
        ok = re.test(merchantClean);
      } catch {
        ok = false;
      }
    } else {
      ok = merchantClean.toLowerCase().includes(pattern.toLowerCase());
    }
    if (ok) candidates.push(rule);
  }
  if (candidates.length === 0) return { rule: null, ambiguous: false };

  candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const la = (a.merchantPattern || '').length;
    const lb = (b.merchantPattern || '').length;
    if (lb !== la) return lb - la;
    return b.id - a.id;
  });

  const best = candidates[0];
  const second = candidates[1];
  if (second) {
    const samePriority = second.priority === best.priority;
    const sameLen =
      (second.merchantPattern || '').length ===
      (best.merchantPattern || '').length;
    if (samePriority && sameLen) {
      return { rule: null, ambiguous: true };
    }
  }
  return { rule: best, ambiguous: false };
}

/**
 * @param {import('sequelize').Sequelize} sequelize
 */
async function loadAllRules(sequelize) {
  const Rule = sequelize.models.Rule;
  return Rule.findAll({ order: [['id', 'ASC']] });
}

function applyRuleToAuto(rule) {
  return {
    autoCategory: rule.category || null,
    autoBusiness: rule.isBusiness,
    autoSplitType: rule.splitType,
    autoPctMe: rule.pctMe != null ? Number(rule.pctMe) : null,
    autoPctPartner: rule.pctPartner != null ? Number(rule.pctPartner) : null,
  };
}

module.exports = {
  findBestRule,
  loadAllRules,
  applyRuleToAuto,
};
