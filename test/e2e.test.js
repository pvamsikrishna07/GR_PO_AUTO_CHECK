// Starts the real app (cds-serve) against the mock DED and drives the two service actions over HTTP.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import PDFDocument from 'pdfkit'
import { startMock } from './mock-s4.js'

const PORT = 4747
const BASE = `http://127.0.0.1:${PORT}`
const AUTH = 'Basic ' + Buffer.from('tester:s3cret').toString('base64')
let mock, app

function makePdf (rows) {
  return new Promise(resolve => {
    const doc = new PDFDocument({ margin: 40 })
    const chunks = []
    doc.on('data', c => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)))
    doc.fontSize(14).text('SHIPPING NOTICE')
    doc.fontSize(10).moveDown()
    const cols = [40, 120, 200, 400, 470]
    let y = doc.y
    ;['PO Number', 'Item', 'Material', 'Qty', 'UoM'].forEach((h, i) => doc.text(h, cols[i], y))
    for (const r of rows) { y += 18; r.forEach((c, i) => doc.text(String(c), cols[i], y)) }
    doc.end()
  })
}

const post = async (name, data, headers = { Authorization: AUTH }) => {
  const res = await fetch(`${BASE}/gr/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

before(async () => {
  mock = await startMock()
  app = spawn(process.execPath, ['node_modules/@sap/cds/bin/serve.js', '--port', String(PORT)], {
    env: { ...process.env, APP_USER: 'tester', APP_PASSWORD: 's3cret', destinations: JSON.stringify([{ name: 'DED_HTTP_200', url: `http://127.0.0.1:${mock.port}` }]) },
    stdio: ['ignore', 'pipe', 'inherit']
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 30000)
    app.stdout.on('data', d => { if (String(d).includes('server listening')) { clearTimeout(t); resolve() } })
    app.on('exit', c => reject(new Error('server exited ' + c)))
  })
})
after(() => { app?.kill(); mock?.server.close() })

test('UI and service are protected by one gate', async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 401)
  assert.equal((await fetch(`${BASE}/gr/$metadata`)).status, 401)
  const ui = await fetch(`${BASE}/`, { headers: { Authorization: AUTH } })
  assert.equal(ui.status, 200)
  assert.match(await ui.text(), /PVK GR PO/)
  assert.match(ui.headers.get('content-security-policy'), /default-src 'self'/)
})

test('rejects non-PDF input', async () => {
  const r = await post('analyze', { fileName: 'x.pdf', pdfBase64: Buffer.from('hello').toString('base64') })
  assert.equal(r.status, 400)
})

test('analyze matches against DED, then GR is posted for confirmed lines', async () => {
  const pdf = await makePdf([
    ['4500000001', '00010', 'MAT-1000', '105', 'PC'], // within +10 % over-delivery tolerance
    ['4500000001', '00020', 'MAT-2000', '30', 'KG'], // 50 ordered, net 20 received -> 30 open
    ['4500000001', '00030', 'MAT-3000', '20', 'PC'], // completely delivered
    ['4500000001', '00010', 'WRONG-1', '10', 'PC'], // material mismatch / duplicate item
    ['4500000009', '00010', 'MAT-1000', '1', 'PC'], // PO unknown
    ['4500000002', '00010', '123456', '10', 'PC'] // matches (leading zeros) but SAP will reject the posting
  ])
  const a = await post('analyze', { fileName: 'dn.pdf', pdfBase64: pdf.toString('base64') })
  assert.equal(a.status, 200, JSON.stringify(a.body))
  const by = i => a.body.lines[i]
  assert.equal(by(0).status, 'MATCHED', by(0).reason)
  assert.equal(by(1).status, 'MATCHED', by(1).reason)
  assert.equal(by(1).s4.openQuantity, 30)
  assert.equal(by(2).status, 'NOT_MATCHED')
  assert.match(by(2).reason, /completely delivered/)
  assert.equal(by(3).status, 'NOT_MATCHED')
  assert.match(by(4).reason, /not found/)
  assert.equal(by(5).status, 'MATCHED', by(5).reason)
  assert.equal(a.body.matched, 3)

  const lines = [by(0), by(1), by(5)].map(({ po, item, material, quantity, uom }) => ({ po, item, material, quantity, uom }))
  const p = await post('postGoodsReceipt', { lines })
  assert.equal(p.status, 200, JSON.stringify(p.body))
  const [r1, r2, r3] = p.body.value
  assert.equal(r1.status, 'POSTED'); assert.match(r1.materialDocument, /^5000000/)
  assert.equal(r2.status, 'POSTED'); assert.notEqual(r1.materialDocument, r2.materialDocument)
  assert.equal(r3.status, 'FAILED'); assert.match(r3.message, /posting period closed/)

  // master data posted comes from DED, with movement type 101 and reference doc type B
  const sent = mock.posted[0].to_MaterialDocumentItem[0]
  assert.equal(sent.GoodsMovementType, '101')
  assert.equal(sent.GoodsMovementRefDocType, 'B')
  assert.equal(sent.Plant, '1010')
  assert.equal(sent.QuantityInEntryUnit, '105')
})

test('server re-validates before posting (tampered quantity is refused)', async () => {
  const p = await post('postGoodsReceipt', { lines: [{ po: '4500000001', item: '00020', material: 'MAT-2000', quantity: 500, uom: 'KG' }] })
  assert.equal(p.body.value[0].status, 'FAILED')
  assert.match(p.body.value[0].message, /outside tolerance/)
})
