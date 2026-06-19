// Verifies the built ESM bundle exports the public primitives.
const mod = await import('../dist/index.js')
const expected = ['Button', 'Badge', 'Card', 'Input', 'Table', 'Dialog', 'Tabs', 'Alert']
const missing = expected.filter((name) => !(name in mod))
if (missing.length > 0) {
  console.error('dist/index.js missing exports:', missing.join(', '))
  process.exit(1)
}
console.log('dist/index.js OK — %d exports', Object.keys(mod).length)
