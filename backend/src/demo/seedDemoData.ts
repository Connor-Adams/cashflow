import {
  Account,
  ExternalOrder,
  ExternalOrderItem,
  Household,
  HouseholdMember,
  Receipt,
  Rule,
  Transaction,
  User,
  sequelize,
} from '../models';
import { hashPassword } from '../auth/password';
import { recomputeTransactionAmounts } from '../import/calculateShares';
import { rowFingerprint, stableIdentityFingerprint } from '../import/fingerprint';
import { logger } from '../observability/logger';
import { isDemoEnabled, resolveDemoPassword } from './demoConfig';

export const DEMO_EMAIL = process.env.DEMO_ACCOUNT_EMAIL?.trim().toLowerCase() || 'dev@cashflow.local';
const DEMO_NAME = process.env.DEMO_ACCOUNT_NAME?.trim() || 'Dev Demo';

type DemoTxn = {
  daysAgo: number;
  merchant: string;
  amount: number;
  category: string;
  splitType?: 'me' | 'partner' | 'shared';
  business?: boolean;
  notes?: string;
  review?: boolean;
};

export function demoSeedEnabled(): boolean {
  return isDemoEnabled(process.env.DEMO_ACCOUNT_ENABLED, process.env.NODE_ENV);
}

export function isDemoUserEmail(email: string | null | undefined): boolean {
  return String(email ?? '').trim().toLowerCase() === DEMO_EMAIL;
}

function isoDateDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function splitPercent(splitType: DemoTxn['splitType']): {
  pctMe: number | null;
  pctPartner: number | null;
} {
  if (splitType === 'shared') return { pctMe: 0.5, pctPartner: 0.5 };
  return { pctMe: null, pctPartner: null };
}

const demoTransactions: DemoTxn[] = [
  { daysAgo: 1, merchant: 'AMZN Mktp CA', amount: -48.56, category: 'Shopping', review: true },
  { daysAgo: 2, merchant: 'AMAZON.CA', amount: -32.18, category: 'Shopping', review: true },
  { daysAgo: 3, merchant: 'Amazon Marketplace', amount: -21.49, category: 'Shopping', review: true },
  { daysAgo: 4, merchant: 'Prime Video', amount: -11.29, category: 'Software', review: true },
  { daysAgo: 5, merchant: 'AMZN MKTP CA', amount: -76.84, category: 'Shopping', review: true },
  { daysAgo: 5, merchant: 'Neighbourhood Bakery', amount: -9.75, category: 'Dining' },
  { daysAgo: 2, merchant: 'Metro Grocery', amount: -86.42, category: 'Groceries', splitType: 'shared' },
  { daysAgo: 3, merchant: 'TTC Presto', amount: -32.5, category: 'Transit' },
  { daysAgo: 4, merchant: 'Stripe Payout', amount: 620, category: 'Freelance', business: true },
  { daysAgo: 6, merchant: 'Bell Canada', amount: -78.12, category: 'Utilities', splitType: 'shared' },
  { daysAgo: 8, merchant: 'Coffee Lab', amount: -14.75, category: 'Dining' },
  { daysAgo: 10, merchant: 'Adobe Creative Cloud', amount: -31.63, category: 'Software', business: true },
  { daysAgo: 13, merchant: 'Shoppers Drug Mart', amount: -44.2, category: 'Health', splitType: 'shared' },
  { daysAgo: 16, merchant: 'Payroll Deposit', amount: 2850, category: 'Income' },
  { daysAgo: 20, merchant: 'Alectra Utilities', amount: -122.89, category: 'Utilities', splitType: 'shared' },
  { daysAgo: 24, merchant: 'Airbnb', amount: -412.18, category: 'Travel', review: true },
  { daysAgo: 31, merchant: 'FreshCo', amount: -63.91, category: 'Groceries', splitType: 'shared' },
  { daysAgo: 39, merchant: 'Client Lunch', amount: -58.3, category: 'Meals', business: true, notes: 'Client meeting' },
  { daysAgo: 45, merchant: 'Rent Payment', amount: -2150, category: 'Rent', splitType: 'shared' },
  { daysAgo: 58, merchant: 'GO Transit', amount: -19.2, category: 'Transit' },
  { daysAgo: 76, merchant: 'Refund - Home Depot', amount: 38.44, category: 'Home', splitType: 'shared' },
];

const demoAmazonOrders = [
  {
    vendorOrderId: '701-1000000-0000001',
    daysAgo: 2,
    total: 48.56,
    items: [
      { title: 'USB-C Cable 2-Pack', totalPrice: 18.99, inferredCategory: 'Office Equipment' },
      { title: 'Bluetooth Keyboard', totalPrice: 29.57, inferredCategory: 'Office Equipment' },
    ],
  },
  {
    vendorOrderId: '701-1000000-0000002',
    daysAgo: 3,
    total: 32.18,
    items: [{ title: 'Coffee Beans', totalPrice: 32.18, inferredCategory: 'Meals & Groceries' }],
  },
  {
    vendorOrderId: '701-1000000-0000003',
    daysAgo: 4,
    total: 21.49,
    items: [{ title: 'Laundry Detergent', totalPrice: 21.49, inferredCategory: 'Household' }],
  },
  {
    vendorOrderId: '701-1000000-0000004',
    daysAgo: 5,
    total: 11.29,
    items: [{ title: 'Productivity App Subscription', totalPrice: 11.29, inferredCategory: 'Software' }],
  },
  {
    vendorOrderId: '701-1000000-0000005',
    daysAgo: 6,
    total: 76.84,
    items: [
      { title: 'Monitor Arm', totalPrice: 55.35, inferredCategory: 'Office Equipment' },
      { title: 'Toothpaste Multipack', totalPrice: 21.49, inferredCategory: 'Personal' },
    ],
  },
];

const demoRules = [
  { merchantPattern: 'metro', category: 'Groceries', splitType: 'shared', pctMe: 0.5, pctPartner: 0.5 },
  { merchantPattern: 'freshco', category: 'Groceries', splitType: 'shared', pctMe: 0.5, pctPartner: 0.5 },
  { merchantPattern: 'presto', category: 'Transit', splitType: 'me', pctMe: null, pctPartner: null },
  { merchantPattern: 'adobe', category: 'Software', splitType: 'me', pctMe: null, pctPartner: null, isBusiness: true },
  { merchantPattern: 'utilities', category: 'Utilities', splitType: 'shared', pctMe: 0.5, pctPartner: 0.5 },
];

export async function seedDemoData(): Promise<void> {
  if (!demoSeedEnabled()) return;

  await sequelize.transaction(async (t) => {
    const existingUser = await User.findOne({
      where: { email: DEMO_EMAIL },
      transaction: t,
    });

    // scrypt (N=16384) is CPU-expensive; only hash when we actually need to
    // create the demo user. Re-hashing on every demo-login when the user
    // already exists was an unauthenticated CPU-amplification vector (#833).
    let user: User;
    if (existingUser) {
      user = existingUser;
    } else {
      const passwordData = await hashPassword(resolveDemoPassword(process.env.DEMO_ACCOUNT_PASSWORD));
      user = await User.create(
        {
          email: DEMO_EMAIL,
          displayName: DEMO_NAME,
          globalRole: 'user',
          passwordHash: passwordData.hash,
          passwordSalt: passwordData.salt,
          passwordParams: passwordData.params,
        },
        { transaction: t }
      );
    }

    let membership = await HouseholdMember.findOne({
      where: { userId: user.id },
      transaction: t,
    });
    let household =
      membership != null
        ? await Household.findByPk(membership.householdId, { transaction: t })
        : null;
    if (!household) {
      household = await Household.create({ name: 'Demo Household' }, { transaction: t });
      membership = await HouseholdMember.create(
        { householdId: household.id, userId: user.id, role: 'owner' },
        { transaction: t }
      );
    }

    const [account] = await Account.findOrCreate({
      where: {
        householdId: household.id,
        shortCode: 'DEMO',
      },
      defaults: {
        name: 'Demo Chequing',
        owner: 'me',
        householdId: household.id,
        ownerUserId: user.id,
        visibility: 'shared',
        shortCode: 'DEMO',
        defaultCurrency: 'CAD',
      },
      transaction: t,
    });

    for (const [i, rule] of demoRules.entries()) {
      await Rule.findOrCreate({
        where: {
          householdId: household.id,
          merchantPattern: rule.merchantPattern,
        },
        defaults: {
          merchantPattern: rule.merchantPattern,
          householdId: household.id,
          createdByUserId: user.id,
          matchKind: 'substring',
          priority: 100 - i,
          category: rule.category,
          isBusiness: Boolean(rule.isBusiness),
          splitType: rule.splitType,
          pctMe: rule.pctMe == null ? null : String(rule.pctMe),
          pctPartner: rule.pctPartner == null ? null : String(rule.pctPartner),
        },
        transaction: t,
      });
    }

    const existingDemoTxnCount = await Transaction.count({
      where: { householdId: household.id },
      transaction: t,
    });
    if (existingDemoTxnCount === 0) {
      for (const [i, row] of demoTransactions.entries()) {
        const splitType = row.splitType || 'me';
        const { pctMe, pctPartner } = splitPercent(splitType);
        const date = isoDateDaysAgo(row.daysAgo);
        const sourceReference = `demo-${i + 1}`;
        const txn = Transaction.build({
          accountId: account.id,
          householdId: household.id,
          createdByUserId: user.id,
          visibility: 'shared',
          ownershipType: splitType,
          ownershipContactId: null,
          importBatch: 'Demo seed',
          date,
          merchantRaw: row.merchant,
          merchantClean: row.merchant,
          amount: String(row.amount),
          currency: 'CAD',
          notes: row.notes ?? null,
          sourceReference,
          sourceRowFingerprint: rowFingerprint({
            accountId: account.id,
            date,
            amount: row.amount,
            currency: 'CAD',
            merchantRaw: row.merchant,
            sourceReference,
          }),
          sourceIdentityFingerprint: stableIdentityFingerprint({
            accountId: account.id,
            date,
            amount: row.amount,
            currency: 'CAD',
            merchantRaw: row.merchant,
          }),
          appliedRuleId: null,
          autoCategory: row.category,
          categoryOverride: null,
          finalCategory: row.category,
          autoBusiness: Boolean(row.business),
          businessOverride: null,
          finalBusiness: Boolean(row.business),
          autoSplitType: splitType,
          splitOverride: null,
          finalSplitType: splitType,
          autoPctMe: pctMe == null ? null : String(pctMe),
          pctMeOverride: null,
          finalPctMe: pctMe == null ? null : String(pctMe),
          autoPctPartner: pctPartner == null ? null : String(pctPartner),
          pctPartnerOverride: null,
          finalPctPartner: pctPartner == null ? null : String(pctPartner),
          myShareAmount: '0',
          partnerShareAmount: '0',
          businessAmount: '0',
          reviewFlag: Boolean(row.review),
          reviewedAt: row.review ? null : new Date(),
        });
        recomputeTransactionAmounts(txn);
        await txn.save({ transaction: t });
      }
    }

    const seededOrders: ExternalOrder[] = [];
    for (const order of demoAmazonOrders) {
      const [externalOrder, created] = await ExternalOrder.findOrCreate({
        where: { householdId: household.id, dedupeKey: `amazon:order:${order.vendorOrderId}` },
        defaults: {
          householdId: household.id,
          createdByUserId: user.id,
          vendor: 'amazon',
          vendorOrderId: order.vendorOrderId,
          dedupeKey: `amazon:order:${order.vendorOrderId}`,
          orderDate: isoDateDaysAgo(order.daysAgo),
          shipmentDate: isoDateDaysAgo(order.daysAgo - 1),
          subtotal: String(order.total),
          tax: '0',
          shipping: '0',
          total: String(order.total),
          currency: 'CAD',
          paymentLast4: '4242',
          source: 'amazon_report',
          rawPayload: { demo: true },
        },
        transaction: t,
      });
      if (created) {
        for (const item of order.items) {
          await ExternalOrderItem.create(
            {
              externalOrderId: externalOrder.id,
              title: item.title,
              quantity: 1,
              unitPrice: String(item.totalPrice),
              totalPrice: String(item.totalPrice),
              inferredCategory: item.inferredCategory,
              businessUsePercent: null,
              confidence: '100',
              rawPayload: { demo: true },
            },
            { transaction: t },
          );
        }
      }
      seededOrders.push(externalOrder);
    }

    // Attach each seeded Amazon order to a demo transaction via a Receipt row.
    // Both /api/items and the transaction receipt-items drawer reach order items
    // only through a Receipt -> transaction link, so without these rows a fresh
    // demo account shows zero items. Orders are matched to a transaction by amount
    // (each Amazon txn equals its order total); the second order is intentionally
    // pinned onto the first order's transaction so the drawer demonstrates its
    // multi-receipt layout (one transaction, two receipts).
    const demoTxns = await Transaction.findAll({
      where: { householdId: household.id },
      transaction: t,
    });
    const txnByAmount = new Map<string, Transaction>();
    for (const txn of demoTxns) {
      const key = Math.abs(Number(txn.amount)).toFixed(2);
      if (!txnByAmount.has(key)) txnByAmount.set(key, txn);
    }
    for (const [i, order] of demoAmazonOrders.entries()) {
      const externalOrder = seededOrders[i];
      if (!externalOrder) continue;
      // Pin the 2nd order onto the 1st order's transaction for the multi-receipt demo.
      const matchTotal = i === 1 ? demoAmazonOrders[0].total : order.total;
      const txn = txnByAmount.get(matchTotal.toFixed(2));
      if (!txn) continue;
      await Receipt.findOrCreate({
        where: { externalOrderId: externalOrder.id },
        defaults: {
          transactionId: txn.id,
          externalOrderId: externalOrder.id,
          storedFilename: `demo/amazon-${order.vendorOrderId}.pdf`,
          originalName: `amazon-order-${order.vendorOrderId}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 1024,
          extractedNote: null,
        },
        transaction: t,
      });
    }
  });

  logger.info({
    email: DEMO_EMAIL,
    enabled: true,
  }, 'demo_seed_complete');
}
