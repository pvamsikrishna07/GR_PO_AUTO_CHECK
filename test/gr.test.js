import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import PDFDocument from 'pdfkit'
import { parseDeliveryNote, parseQuantity, extractFromPdf } from '../srv/lib/pdf-extract.js'
import { startMock } from './mock-s4.js'

function makePdf (rows, header = []) {
  return new Promise(resolve => {
    const doc = new PDFDocument({ margin: 40 })
    const chunks = []
    doc.on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)))
    doc.fontSize(16).text('DELIVERY NOTE  DN-778812')
    doc.fontSize(10)
    for (const h of header) doc.text(h)
    doc.moveDown()
    const cols = [40, 110, 190, 380, 450]
    const heads = ['PO Number', 'Item', 'Material', 'Qty', 'UoM']
    let y = doc.y
    heads.forEach((h, i) => doc.text(h, cols[i], y))
    for (const r of rows) {
      y += 18
      r.forEach((c, i) => doc.text(String(c), cols[i], y))
    }
    doc.end()
  })
}

test('quantity parsing', () => {
  assert.equal(parseQuantity('100'), 100)
  assert.equal(parseQuantity('1,250.50'), 1250.5)
  assert.equal(parseQuantity('1.250,50'), 1250.5)
  assert.equal(parseQuantity('10,5'), 10.5)
  assert.equal(parseQuantity('10.000'), 10)
  assert.equal(parseQuantity('1,250'), 1250)
  assert.equal(parseQuantity('1,250,000'), 1250000)
})

test('parses table rows with PO per row', () => {
  const { lines } = parseDeliveryNote([
    'PO Number\tItem\tMaterial\tQty\tUoM',
    '4500000001\t00010\tMAT-1000\t100\tPC',
    '4500000001  20  MAT-2000  30.000  KG',
    '4500000002/10 000000000000123456 10 EA'
  ].join('\n'))
  assert.equal(lines.length, 3)
  assert.deepEqual(lines.map(l => [l.po, l.item, l.material, l.quantity, l.uom]), [
    ['4500000001', '00010', 'MAT-1000', 100, 'PC'],
    ['4500000001', '00020', 'MAT-2000', 30, 'KG'],
    ['4500000002', '00010', '000000000000123456', 10, 'EA']
  ])
})

test('uses header PO when rows have none, and labelled fallback', () => {
  const a = parseDeliveryNote('Purchase Order: 4500000001\n00010 MAT-1000 Widget 5 PCS')
  assert.equal(a.lines[0].po, '4500000001')
  assert.equal(a.lines[0].quantity, 5)
  const b = parseDeliveryNote('PO No: 4500000001\nPO Item: 10\nMaterial: MAT-1000\nQuantity: 7 PC\nPO Item: 20\nMaterial: MAT-2000\nQuantity: 3 KG')
  assert.equal(b.lines.length, 2)
  assert.deepEqual(b.lines.map(l => [l.item, l.material, l.quantity, l.uom]), [['00010', 'MAT-1000', 7, 'PC'], ['00020', 'MAT-2000', 3, 'KG']])
})

test('extracts from a real generated PDF', async () => {
  const pdf = await makePdf([
    ['4500000001', '00010', 'MAT-1000', '100', 'PC'],
    ['4500000001', '00020', 'MAT-2000', '30', 'KG']
  ])
  const r = await extractFromPdf(pdf)
  assert.equal(r.lines.length, 2, r.text)
  assert.equal(r.lines[0].po, '4500000001')
  assert.equal(r.lines[1].quantity, 30)
})
