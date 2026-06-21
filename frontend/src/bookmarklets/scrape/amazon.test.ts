import { describe, it, expect } from 'vitest'
import { extractAmazonOrdersFromDom, parseCurrencyCode } from './amazon'

function doc(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

describe('parseCurrencyCode', () => {
  it('maps Amazon currency markers to ISO codes, defaulting to CAD', () => {
    expect(parseCurrencyCode('CDN$ 42.00')).toBe('CAD')
    expect(parseCurrencyCode('CA$42.00')).toBe('CAD')
    expect(parseCurrencyCode('US$42.00')).toBe('USD')
    expect(parseCurrencyCode('USD 42.00')).toBe('USD')
    expect(parseCurrencyCode('£42.00')).toBe('GBP')
    expect(parseCurrencyCode('€42.00')).toBe('EUR')
    expect(parseCurrencyCode('$42.00')).toBe('CAD') // bare $ is ambiguous → household default
  })
})

const ORDER_HTML = `
<div class="order-card js-order-card">
  <div class="order-header">
    <div class="a-column"><span class="label">Order placed</span><span class="value">May 15, 2026</span></div>
    <div class="a-column"><span class="label">Total</span><span class="value">US$58.00</span></div>
    <div class="a-column"><span class="label">Ship to</span><span class="value">Home</span></div>
    <div class="a-column"><span class="label">Order #</span><span class="value">701-1234567-7654321</span></div>
  </div>
  <div class="a-fixed-left-grid order-card__list-item">
    <a class="a-link-normal yohtmlc-product-title">Mechanical Keyboard</a>
    <span class="a-price"><span class="a-offscreen">US$48.00</span></span>
    <span class="item-view-qty">2</span>
  </div>
  <div class="a-fixed-left-grid order-card__list-item">
    <a class="a-link-normal yohtmlc-product-title">USB-C Cable</a>
    <span class="a-color-price">US$10.00</span>
  </div>
  <div class="a-row">Visa ending in 1234</div>
</div>`

describe('extractAmazonOrdersFromDom', () => {
  it('extracts order-level fields, currency, last4, and per-item price/quantity', () => {
    const orders = extractAmazonOrdersFromDom(doc(ORDER_HTML))
    expect(orders).toHaveLength(1)
    const o = orders[0]
    expect(o.vendorOrderId).toBe('701-1234567-7654321')
    expect(o.orderDate).toBe('2026-05-15')
    expect(o.total).toBe(58)
    expect(o.currency).toBe('USD')
    expect(o.paymentLast4).toBe('1234')
    expect(o.items).toHaveLength(2)
    expect(o.items[0]).toEqual({ title: 'Mechanical Keyboard', quantity: 2, unitPrice: null, totalPrice: 48 })
    expect(o.items[1]).toEqual({ title: 'USB-C Cable', quantity: 1, unitPrice: null, totalPrice: 10 })
  })

  it('omits an order missing a parseable date or total', () => {
    const orders = extractAmazonOrdersFromDom(doc('<div class="order-card"><div class="order-header"></div></div>'))
    expect(orders).toHaveLength(0)
  })

  it('returns items with null prices when the DOM has no price nodes', () => {
    const html = `<div class="order-card"><div class="order-header">
      <div class="a-column"><span class="label">Order placed</span><span class="value">May 1, 2026</span></div>
      <div class="a-column"><span class="label">Total</span><span class="value">$5.00</span></div>
    </div>
    <div class="order-card__list-item"><a class="yohtmlc-product-title">Sticker</a></div></div>`
    const orders = extractAmazonOrdersFromDom(doc(html))
    expect(orders[0].currency).toBe('CAD')
    expect(orders[0].items[0]).toEqual({ title: 'Sticker', quantity: 1, unitPrice: null, totalPrice: null })
  })

  it('extracts two distinct orders from a page with multiple order-card blocks', () => {
    const html = `
<div class="order-card js-order-card">
  <div class="order-header">
    <div class="a-column"><span class="label">Order placed</span><span class="value">January 10, 2026</span></div>
    <div class="a-column"><span class="label">Total</span><span class="value">US$20.00</span></div>
    <div class="a-column"><span class="label">Order #</span><span class="value">111-1111111-1111111</span></div>
  </div>
  <div class="order-card__list-item"><a class="yohtmlc-product-title">Widget A</a><span class="a-price"><span class="a-offscreen">US$20.00</span></span></div>
</div>
<div class="order-card js-order-card">
  <div class="order-header">
    <div class="a-column"><span class="label">Order placed</span><span class="value">February 20, 2026</span></div>
    <div class="a-column"><span class="label">Total</span><span class="value">US$35.00</span></div>
    <div class="a-column"><span class="label">Order #</span><span class="value">222-2222222-2222222</span></div>
  </div>
  <div class="order-card__list-item"><a class="yohtmlc-product-title">Widget B</a><span class="a-price"><span class="a-offscreen">US$35.00</span></span></div>
</div>`
    const orders = extractAmazonOrdersFromDom(doc(html))
    expect(orders).toHaveLength(2)
    expect(orders[0].vendorOrderId).toBe('111-1111111-1111111')
    expect(orders[1].vendorOrderId).toBe('222-2222222-2222222')
  })

  it('returns paymentLast4: null when a 4-digit number appears only in a product title, not as card phrasing', () => {
    const html = `<div class="order-card">
      <div class="order-header">
        <div class="a-column"><span class="label">Order placed</span><span class="value">March 1, 2026</span></div>
        <div class="a-column"><span class="label">Total</span><span class="value">US$29.99</span></div>
      </div>
      <div class="order-card__list-item"><a class="yohtmlc-product-title">Echo Dot 2024</a></div>
    </div>`
    const orders = extractAmazonOrdersFromDom(doc(html))
    expect(orders).toHaveLength(1)
    expect(orders[0].paymentLast4).toBeNull()
  })
})
