// Minimal stand-in for DED used by the local tests: PO items (OData V4), material document items and
// goods receipt posting (OData V2, with CSRF token handling like a real Gateway).
import http from 'node:http'

export const POS = {
  4500000001: [
    { PurchaseOrderItem: '00010', Material: 'MAT-1000', Plant: '1010', StorageLocation: '0001', OrderQuantity: '100', PurchaseOrderQuantityUnit: 'PC', UnderdelivTolrtdLmtRatioInPct: 0, OverdelivTolrtdLmtRatioInPct: 10 },
    { PurchaseOrderItem: '00020', Material: 'MAT-2000', Plant: '1010', StorageLocation: '0001', OrderQuantity: '50', PurchaseOrderQuantityUnit: 'KG' },
    { PurchaseOrderItem: '00030', Material: 'MAT-3000', Plant: '1010', StorageLocation: '0002', OrderQuantity: '20', PurchaseOrderQuantityUnit: 'PC', IsCompletelyDelivered: true }
  ],
  4500000002: [
    { PurchaseOrderItem: '00010', Material: '000000000000123456', Plant: '1010', StorageLocation: '0001', OrderQuantity: '10', PurchaseOrderQuantityUnit: 'PC' }
  ]
}
// already received: PO 4500000001 item 20 has 20 KG received (so 30 KG are open)
const MATDOC = [
  { PurchaseOrder: '4500000001', PurchaseOrderItem: '00020', GoodsMovementType: '101', QuantityInEntryUnit: '25' },
  { PurchaseOrder: '4500000001', PurchaseOrderItem: '00020', GoodsMovementType: '102', QuantityInEntryUnit: '5' }
]

export function startMock (port = 0) {
  const posted = []
  const TOKEN = 'mock-csrf-token'
  let docNo = 5000000100
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const json = (code, body, extra = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(body)) }
    let m
    if (req.method === 'POST' || req.method === 'GET' || req.method === 'HEAD') {
      if (req.headers['x-csrf-token'] === 'Fetch') res.setHeader('x-csrf-token', TOKEN)
    }
    if (req.method !== 'POST' && (m = /\/PurchaseOrder\('(\d+)'\)\/_PurchaseOrderItem$/.exec(url.pathname))) {
      const items = POS[m[1]]
      if (!items) return json(404, { error: { message: `PO ${m[1]} not found` } })
      return json(200, { value: items })
    }
    if (req.method === 'GET' && url.pathname.endsWith('/A_MaterialDocumentItem')) {
      const po = /PurchaseOrder eq '(\d+)'/.exec(url.searchParams.get('$filter') || '')?.[1]
      return json(200, { d: { results: MATDOC.filter(r => r.PurchaseOrder === po) } })
    }
    if (req.method === 'POST' && url.pathname.endsWith('/A_MaterialDocumentHeader')) {
      if (req.headers['x-csrf-token'] !== TOKEN) return json(403, { error: { message: { value: 'CSRF token validation failed' } } })
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        const p = JSON.parse(body)
        const it = p.to_MaterialDocumentItem[0]
        if (it.PurchaseOrder === '4500000002') return json(400, { error: { message: { value: 'Mock: posting period closed' } } })
        posted.push(p)
        json(201, { d: { MaterialDocument: String(docNo++), MaterialDocumentYear: '2026' } })
      })
      return
    }
    json(404, { error: { message: 'not found ' + url.pathname } })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({ server, posted, port: server.address().port })))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMock(4010)
  console.log(`mock DED listening on http://127.0.0.1:${port}`)
}
