import { describe, it, expect } from 'vitest'
import {
  summarizeOrders,
  rollUpCategories,
  type ReceiptOrder,
  type ReceiptItem,
} from './receiptDerivations'

function order(partial: Partial<ReceiptOrder>): ReceiptOrder {
  return {
    id: 1,
    vendor: 'costco',
    source: null,
    orderDate: '2026-02-13',
    subtotal: null,
    tax: null,
    shipping: null,
    total: null,
    currency: 'CAD',
    paymentLast4: null,
    linkStatus: 'orphan',
    items: [],
    ...partial,
  }
}

function item(partial: Partial<ReceiptItem>): ReceiptItem {
  return { id: 1, title: 'x', quantity: 1, unitPrice: null, totalPrice: null, inferredCategory: null, ...partial }
}

describe('summarizeOrders', () => {
  it('counts orders and orphans, and sums total and tax skipping nulls', () => {
    const s = summarizeOrders([
      order({ id: 1, linkStatus: 'orphan', total: '562.33', tax: '23.17' }),
      order({ id: 2, linkStatus: 'linked', total: '582.64', tax: '27.00' }),
      order({ id: 3, linkStatus: 'linked', total: null, tax: null }),
    ])
    expect(s.count).toBe(3)
    expect(s.orphanCount).toBe(1)
    expect(s.totalSum).toBeCloseTo(1144.97, 2)
    expect(s.taxSum).toBeCloseTo(50.17, 2)
  })

  it('returns zeroes for an empty list', () => {
    expect(summarizeOrders([])).toEqual({ count: 0, orphanCount: 0, totalSum: 0, taxSum: 0 })
  })
})

describe('rollUpCategories', () => {
  it('groups by inferredCategory, sums positive totals, sorts descending', () => {
    const cats = rollUpCategories([
      item({ id: 1, inferredCategory: 'Groceries', totalPrice: '10.00' }),
      item({ id: 2, inferredCategory: 'Alcohol', totalPrice: '30.00' }),
      item({ id: 3, inferredCategory: 'Groceries', totalPrice: '5.00' }),
    ])
    expect(cats).toEqual([
      { category: 'Alcohol', total: 30 },
      { category: 'Groceries', total: 15 },
    ])
  })

  it('ignores items with no category, null price, or non-positive price', () => {
    const cats = rollUpCategories([
      item({ id: 1, inferredCategory: null, totalPrice: '10.00' }),
      item({ id: 2, inferredCategory: 'Groceries', totalPrice: null }),
      item({ id: 3, inferredCategory: 'Discounts', totalPrice: '-2.00' }),
      item({ id: 4, inferredCategory: 'Groceries', totalPrice: '8.00' }),
    ])
    expect(cats).toEqual([{ category: 'Groceries', total: 8 }])
  })

  it('caps at 5 categories and folds the rest into "Other"', () => {
    const cats = rollUpCategories([
      item({ id: 1, inferredCategory: 'A', totalPrice: '60' }),
      item({ id: 2, inferredCategory: 'B', totalPrice: '50' }),
      item({ id: 3, inferredCategory: 'C', totalPrice: '40' }),
      item({ id: 4, inferredCategory: 'D', totalPrice: '30' }),
      item({ id: 5, inferredCategory: 'E', totalPrice: '20' }),
      item({ id: 6, inferredCategory: 'F', totalPrice: '5' }),
      item({ id: 7, inferredCategory: 'G', totalPrice: '3' }),
    ])
    expect(cats).toHaveLength(6)
    expect(cats[5]).toEqual({ category: 'Other', total: 8 })
  })

  it('returns an empty array when nothing is categorized', () => {
    expect(rollUpCategories([item({ inferredCategory: null, totalPrice: '10' })])).toEqual([])
  })
})
