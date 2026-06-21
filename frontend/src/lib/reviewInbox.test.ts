import { describe, expect, it } from 'vitest'
import type { Transaction } from '../types/api'
import {
  buildReviewBulkPatch,
  getReviewInboxSummary,
  getSelectedReviewSummary,
} from './reviewInbox'

function txn(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    accountId: 1,
    householdId: 1,
    createdByUserId: 1,
    visibility: 'shared',
    ownershipType: 'me',
    ownershipContactId: null,
    importBatch: 'May Visa',
    date: '2026-05-01',
    merchantRaw: 'Coffee Shop',
    merchantClean: 'Coffee Shop',
    amount: -12.5,
    currency: 'CAD',
    notes: null,
    sourceReference: null,
    sourceRowFingerprint: 'fp',
    appliedRuleId: null,
    autoCategory: null,
    categoryOverride: null,
    finalCategory: null,
    autoBusiness: null,
    businessOverride: null,
    finalBusiness: false,
    autoSplitType: null,
    splitOverride: null,
    finalSplitType: 'me',
    autoPctMe: null,
    pctMeOverride: null,
    finalPctMe: 1,
    autoPctPartner: null,
    pctPartnerOverride: null,
    finalPctPartner: 0,
    myShareAmount: -12.5,
    partnerShareAmount: 0,
    businessAmount: 0,
    reviewFlag: true,
    reviewedAt: null,
    ...overrides,
  }
}

describe('reviewInbox helpers', () => {
  it('summarizes review progress and batches', () => {
    const summary = getReviewInboxSummary([
      txn({ id: 1, importBatch: 'May Visa', reviewFlag: true, amount: -12.5 }),
      txn({ id: 2, importBatch: 'May Visa', reviewFlag: false, amount: -30 }),
      txn({ id: 3, importBatch: 'Amex', reviewFlag: true, amount: -7 }),
    ])

    expect(summary).toEqual({
      total: 3,
      reviewed: 1,
      unreviewed: 2,
      batches: [
        { name: 'May Visa', total: 2, unreviewed: 1 },
        { name: 'Amex', total: 1, unreviewed: 1 },
      ],
    })
  })

  it('summarizes selected rows by count, absolute spend, and common merchant', () => {
    const rows = [
      txn({ id: 1, merchantClean: 'Uber', amount: -20, currency: 'CAD' }),
      txn({ id: 2, merchantClean: 'Uber', amount: -30, currency: 'CAD' }),
      txn({ id: 3, merchantClean: 'Lyft', amount: -10, currency: 'CAD' }),
    ]

    expect(getSelectedReviewSummary(rows, new Set([1, 2]))).toEqual({
      count: 2,
      absoluteSpend: 50,
      currency: 'CAD',
      commonMerchant: 'Uber',
    })

    expect(getSelectedReviewSummary(rows, new Set([1, 3])).commonMerchant).toBeNull()
  })

  it('builds the minimal bulk patch for review decisions', () => {
    expect(
      buildReviewBulkPatch({
        category: 'Transport',
        business: 'false',
        splitType: 'shared',
        taxTreatment: '',
        markReviewed: true,
      })
    ).toEqual({
      categoryOverride: 'Transport',
      businessOverride: false,
      splitOverride: 'shared',
      reviewFlag: false,
    })
  })

  it('includes taxTreatmentOverride when a tax treatment is selected', () => {
    expect(
      buildReviewBulkPatch({
        category: '',
        business: '',
        splitType: '',
        taxTreatment: 'donations',
        markReviewed: false,
      })
    ).toEqual({ taxTreatmentOverride: 'donations' })
  })

  it('omits taxTreatmentOverride when tax treatment is empty (keep current)', () => {
    expect(
      buildReviewBulkPatch({
        category: 'Transport',
        business: '',
        splitType: '',
        taxTreatment: '',
        markReviewed: false,
      })
    ).toEqual({ categoryOverride: 'Transport' })
  })

  it('emits categoryOverrideId when a resolved id is provided', () => {
    const patch = buildReviewBulkPatch({ category: '', categoryOverrideId: 7, business: '', splitType: '', taxTreatment: '', markReviewed: true })
    expect(patch.categoryOverrideId).toBe(7)
    expect('categoryOverride' in patch).toBe(false)
  })

  it('omits category fields when neither string nor id set', () => {
    const patch = buildReviewBulkPatch({ category: '', categoryOverrideId: null, business: '', splitType: '', taxTreatment: '', markReviewed: true })
    expect('categoryOverrideId' in patch).toBe(false)
    expect('categoryOverride' in patch).toBe(false)
  })
})
