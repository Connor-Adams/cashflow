// backend/src/categories/mergePlanFixture.ts
// A snapshot of Connor-Adams/cashflow household 1 taken 2026-09-30, used by
// mergePlan.budgetInvariance.test.ts to prove the duplicate-category merge does
// not change what any budget counts. Names and amounts only.
export type FixtureCategory = { id: number; parentId: number | null; name: string };
export type FixtureBudget = {
  id: number; category: string; categoryId: number | null; currency: string; amount: string;
};
/** September 2026 dashboard-eligible spend, keyed by the raw final_category string. */
export type FixtureSpend = { currency: string; finalCategory: string; spent: number };

export const HOUSEHOLD_ID = 1;

export const FIXTURE_CATEGORIES: FixtureCategory[] = [
  { id: 1, parentId: 39, name: 'Credit Reporting' },
  { id: 2, parentId: 51, name: 'Haircut' },
  { id: 3, parentId: null, name: 'Uncategorized' },
  { id: 4, parentId: 48, name: 'Yeti' },
  { id: 5, parentId: 38, name: 'Parking' },
  { id: 6, parentId: 53, name: 'Travel' },
  { id: 8, parentId: 6, name: 'ESim' },
  { id: 9, parentId: 53, name: 'Racing' },
  { id: 10, parentId: 14, name: 'Desk' },
  { id: 11, parentId: 48, name: 'Internet' },
  { id: 12, parentId: 48, name: 'Rent' },
  { id: 13, parentId: 48, name: 'Clothing' },
  { id: 14, parentId: null, name: 'Office Equipment' },
  { id: 15, parentId: 38, name: 'Miami Uber' },
  { id: 16, parentId: 19, name: 'Clublink' },
  { id: 17, parentId: 53, name: 'Games' },
  { id: 18, parentId: null, name: 'Payment' },
  { id: 19, parentId: 53, name: 'Golf' },
  { id: 20, parentId: 48, name: 'Weed' },
  { id: 21, parentId: 50, name: 'Spotify' },
  { id: 22, parentId: 48, name: 'Eating Out' },
  { id: 23, parentId: 13, name: 'Snowboarding Gear' },
  { id: 24, parentId: 51, name: 'Diabetes' },
  { id: 25, parentId: 38, name: 'Car' },
  { id: 26, parentId: 48, name: 'Coffee' },
  { id: 27, parentId: 14, name: 'Laptop' },
  { id: 28, parentId: 50, name: 'Ai' },
  { id: 29, parentId: null, name: 'Hosting' },
  { id: 30, parentId: 48, name: 'Alcohol' },
  { id: 31, parentId: 39, name: 'cc fees' },
  { id: 32, parentId: 48, name: 'Groceries' },
  { id: 33, parentId: 48, name: 'Biba' },
  { id: 34, parentId: null, name: 'Shipping' },
  { id: 35, parentId: 51, name: 'Dentist' },
  { id: 36, parentId: null, name: 'Transfer' },
  { id: 37, parentId: 38, name: 'Gas' },
  { id: 38, parentId: null, name: 'Transportation' },
  { id: 39, parentId: null, name: 'Accounting' },
  { id: 40, parentId: 48, name: 'Vape' },
  { id: 41, parentId: 39, name: 'Taxes' },
  { id: 42, parentId: null, name: 'Cottage' },
  { id: 43, parentId: null, name: 'ring' },
  { id: 44, parentId: null, name: 'Investments' },
  { id: 45, parentId: null, name: 'Investment income' },
  { id: 46, parentId: null, name: 'Other' },
  { id: 47, parentId: null, name: 'Electronics' },
  { id: 48, parentId: null, name: 'Household' },
  { id: 50, parentId: null, name: 'Subscriptions' },
  { id: 51, parentId: null, name: 'Healthcare' },
  { id: 52, parentId: null, name: 'Sephora' },
  { id: 53, parentId: null, name: 'Hobbies' },
  { id: 54, parentId: 50, name: 'Google One' },
  { id: 55, parentId: 29, name: 'Domains' },
  { id: 56, parentId: 6, name: 'France' },
  { id: 57, parentId: null, name: 'LuLu Lemon' },
  { id: 58, parentId: 48, name: 'Birthday Gifts' },
  { id: 59, parentId: 50, name: 'Discord Nitro' },
  { id: 61, parentId: null, name: 'tire air' },
  { id: 62, parentId: null, name: 'Internet Hardware' },
  { id: 67, parentId: null, name: 'Apple' },
  { id: 68, parentId: null, name: 'Amazon' },
  { id: 69, parentId: null, name: 'Groceries' },
  { id: 70, parentId: null, name: 'Dining' },
  { id: 71, parentId: null, name: 'Eating Out' },
  { id: 72, parentId: null, name: 'cc fees' },
  { id: 73, parentId: null, name: 'Travel' },
  { id: 74, parentId: 48, name: 'Office Equipment' },
  { id: 75, parentId: null, name: 'Clothing' },
  { id: 76, parentId: null, name: 'Golf' },
  { id: 77, parentId: null, name: 'Gas' },
  { id: 78, parentId: null, name: 'Domains' },
  { id: 79, parentId: null, name: 'Discord Nitro' },
  { id: 80, parentId: null, name: 'Weed' },
  { id: 81, parentId: null, name: 'Alcohol' },
  { id: 82, parentId: null, name: 'Vape' },
  { id: 83, parentId: null, name: 'Diabetes' },
  { id: 84, parentId: 48, name: 'Beverages' },
  { id: 85, parentId: null, name: 'Ai' },
  { id: 86, parentId: null, name: 'Insurance' },
  { id: 87, parentId: 86, name: 'Tenant Insurance' },
];

/**
 * Total references per category id across transactions.{final,auto,category_override}_category_id,
 * rules.category_id, budget_targets.category_id, income_entries.category_id and
 * external_order_items.{inferred,category_override}_category_id. Measured against
 * prod on 2026-09-30 with a single UNION ALL count, not derived by hand.
 * Only the ids inside a duplicate group matter to Rule W; everything else is 0 here.
 */
export const FIXTURE_REF_COUNTS: Record<number, number> = {
  28: 16, 85: 2,       // Ai
  30: 63, 81: 7,       // Alcohol
  31: 218, 72: 3,      // cc fees
  13: 15, 75: 1,       // Clothing
  24: 44, 83: 2,       // Diabetes
  59: 17, 79: 0,       // Discord Nitro
  55: 9, 78: 0,        // Domains
  22: 1241, 71: 15,    // Eating Out
  37: 70, 77: 2,       // Gas
  19: 36, 76: 1,       // Golf
  32: 454, 69: 13,     // Groceries
  14: 135, 74: 0,      // Office Equipment — the ROOT is canonical here
  6: 54, 73: 0,        // Travel
  40: 41, 82: 9,       // Vape
  20: 87, 80: 0,       // Weed
};

export const FIXTURE_BUDGETS: FixtureBudget[] = [
  { id: 1, category: 'Rent', categoryId: 12, currency: 'CAD', amount: '2907.0000' },
  { id: 2, category: 'Clublink', categoryId: 16, currency: 'CAD', amount: '879.0000' },
  { id: 3, category: 'Internet', categoryId: 11, currency: 'CAD', amount: '204.0000' },
  { id: 4, category: 'Subscriptions', categoryId: 50, currency: 'CAD', amount: '45.0000' },
  { id: 5, category: 'cc fees', categoryId: 72, currency: 'CAD', amount: '40.0000' },
  { id: 6, category: 'Groceries', categoryId: 69, currency: 'CAD', amount: '700.0000' },
  { id: 7, category: 'Household', categoryId: null, currency: 'CAD', amount: '200.0000' },
  { id: 8, category: 'Healthcare', categoryId: 51, currency: 'CAD', amount: '350.0000' },
  { id: 9, category: 'Transportation', categoryId: 38, currency: 'CAD', amount: '100.0000' },
  { id: 10, category: 'Eating Out', categoryId: 71, currency: 'CAD', amount: '175.0000' },
  { id: 11, category: 'Dining', categoryId: 70, currency: 'CAD', amount: '50.0000' },
  { id: 12, category: 'Alcohol', categoryId: 81, currency: 'CAD', amount: '50.0000' },
  { id: 14, category: 'Vape', categoryId: 82, currency: 'CAD', amount: '25.0000' },
  { id: 15, category: 'Amazon', categoryId: 68, currency: 'CAD', amount: '200.0000' },
  { id: 16, category: 'Clothing', categoryId: 75, currency: 'CAD', amount: '75.0000' },
  { id: 17, category: 'Golf', categoryId: 76, currency: 'CAD', amount: '50.0000' },
  { id: 18, category: 'Office Equipment', categoryId: 14, currency: 'CAD', amount: '40.0000' },
  { id: 19, category: 'Other', categoryId: 46, currency: 'CAD', amount: '25.0000' },
  { id: 21, category: 'Apple', categoryId: 67, currency: 'CAD', amount: '150.0000' },
  { id: 22, category: 'Hobbies', categoryId: null, currency: 'CAD', amount: '1.0000' },
  { id: 23, category: 'Electronics', categoryId: 47, currency: 'CAD', amount: '1.0000' },
  { id: 24, category: 'France', categoryId: 56, currency: 'CAD', amount: '1.0000' },
  { id: 25, category: 'Insurance', categoryId: 86, currency: 'CAD', amount: '260.0000' },
];

/** September 2026, amount < 0, dashboard-eligible txn_types, keyed by raw final_category. */
export const FIXTURE_SPEND: FixtureSpend[] = [
  { currency: 'CAD', finalCategory: 'Accounting', spent: 22.6 },
  { currency: 'CAD', finalCategory: 'Alcohol', spent: 290.9 },
  { currency: 'CAD', finalCategory: 'Amazon', spent: 86.94 },
  { currency: 'CAD', finalCategory: 'Apple', spent: 59.28 },
  { currency: 'CAD', finalCategory: 'cc fees', spent: 21.99 },
  { currency: 'CAD', finalCategory: 'Dining', spent: 237.92 },
  { currency: 'CAD', finalCategory: 'Eating Out', spent: 17.73 },
  { currency: 'CAD', finalCategory: 'Groceries', spent: 878.06 },
  { currency: 'CAD', finalCategory: 'Healthcare', spent: 172.13 },
  { currency: 'CAD', finalCategory: 'Healthcare / Dentist', spent: 252.0 },
  { currency: 'CAD', finalCategory: 'Healthcare / Diabetes', spent: 204.52 },
  { currency: 'CAD', finalCategory: 'Hobbies', spent: 35.69 },
  { currency: 'CAD', finalCategory: 'Hobbies / Travel', spent: 20.23 },
  { currency: 'CAD', finalCategory: 'Hosting', spent: 44.76 },
  { currency: 'CAD', finalCategory: 'Household', spent: 793.68 },
  { currency: 'CAD', finalCategory: 'Household / Vape', spent: 265.48 },
  { currency: 'CAD', finalCategory: 'Internet', spent: 203.34 },
  { currency: 'CAD', finalCategory: 'Rent', spent: 2906.72 },
  { currency: 'CAD', finalCategory: 'Spotify', spent: 15.81 },
  { currency: 'CAD', finalCategory: 'Subscriptions', spent: 3.38 },
  { currency: 'CAD', finalCategory: 'Transportation', spent: 27.92 },
  { currency: 'CAD', finalCategory: 'Transportation / Gas', spent: 3.49 },
];
