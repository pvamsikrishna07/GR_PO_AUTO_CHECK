import { executeHttpRequest } from '@sap-cloud-sdk/http-client'

/** BTP destination pointing to DED (client 200). Override with S4_DESTINATION only for testing. */
const destination = () => ({ destinationName: process.env.S4_DESTINATION || 'DED_HTTP_200' })

const PO_PATH = () => (process.env.S4_PO_PATH || '/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001').replace(/\/$/, '')
const MD_PATH = () => (process.env.S4_MATDOC_PATH || '/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV').replace(/\/$/, '')

const isPo = v => /^\d{10}$/.test(String(v))
const isItem = v => /^\d{5}$/.test(String(v))
const queryString = o => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
const num = v => (v === null || v === undefined || v === '' ? 0 : Number(v))

/** Extract the message SAP returned (OData V2 and V4 error shapes) from a failed request. */
export function sapMessage (e) {
  const data = e?.response?.data ?? e?.cause?.response?.data
  const msg = data?.error?.message
  const text = typeof msg === 'string' ? msg : msg?.value
  if (text) return text
  const status = e?.response?.status ?? e?.cause?.response?.status
  const base = e?.rootCause?.message || e?.cause?.message || e?.message || 'Unknown error'
  return status ? `HTTP ${status}: ${base}` : base
}

async function request (config) {
  const res = await executeHttpRequest(destination(), {
    ...config,
    headers: { Accept: 'application/json', ...(config.headers || {}) }
  })
  return res.data
}

function mapItem (r) {
  return {
    item: String(r.PurchaseOrderItem).padStart(5, '0'),
    material: r.Material || '',
    plant: r.Plant || '',
    storageLocation: r.StorageLocation || '',
    batch: r.Batch || '',
    orderQuantity: num(r.OrderQuantity),
    unit: r.PurchaseOrderQuantityUnit || '',
    underTolerancePct: num(r.UnderdelivTolrtdLmtRatioInPct),
    overTolerancePct: num(r.OverdelivTolrtdLmtRatioInPct),
    completelyDelivered: r.IsCompletelyDelivered === true || r.IsCompletelyDelivered === 'X',
    deleted: !!r.PurchasingDocumentDeletionCode,
    receivedQuantity: 0
  }
}

async function readItems (po) {
  try {
    const d = await request({ method: 'GET', url: `${PO_PATH()}/PurchaseOrder('${po}')/_PurchaseOrderItem` })
    return d.value || []
  } catch (e) {
    if (e?.response?.status !== 404) throw e
    // some releases only expose the item entity set - try a filter on it
    const d = await request({ method: 'GET', url: `${PO_PATH()}/PurchaseOrderItem?${queryString({ $filter: `PurchaseOrder eq '${po}'` })}` })
    return d.value || []
  }
}

/** Net goods receipt quantity per PO item (movement types 101 minus 102). */
async function readReceivedQuantities (po) {
  const query = queryString({
    $filter: `PurchaseOrder eq '${po}' and (GoodsMovementType eq '101' or GoodsMovementType eq '102')`,
    $select: 'PurchaseOrderItem,GoodsMovementType,QuantityInEntryUnit',
    $top: 5000,
    $format: 'json'
  })
  const d = await request({ method: 'GET', url: `${MD_PATH()}/A_MaterialDocumentItem?${query}` })
  const totals = new Map()
  for (const r of d?.d?.results || d?.value || []) {
    const item = String(r.PurchaseOrderItem).padStart(5, '0')
    const q = num(r.QuantityInEntryUnit) * (r.GoodsMovementType === '102' ? -1 : 1)
    totals.set(item, (totals.get(item) || 0) + q)
  }
  return totals
}

/** Read a PO (items + net received quantities) from DED. Never throws - errors are returned in `error`. */
export async function readPurchaseOrder (po) {
  if (!isPo(po)) return { error: `"${po}" is not a valid 10-digit PO number`, items: new Map() }
  try {
    const [rows, received] = await Promise.all([readItems(po), readReceivedQuantities(po)])
    const items = new Map()
    for (const r of rows) {
      const it = mapItem(r)
      it.receivedQuantity = received.get(it.item) || 0
      items.set(it.item, it)
    }
    return { items }
  } catch (e) {
    const status = e?.response?.status
    return { error: status === 404 ? `PO ${po} not found in DED` : `DED read failed for PO ${po}: ${sapMessage(e)}`, items: new Map() }
  }
}

const sapDate = (d = new Date()) => `${d.toISOString().slice(0, 10)}T00:00:00`

/**
 * Post a goods receipt (movement type 101, reference document type B) for one PO item.
 * Master data (material, plant, storage location, batch) always comes from the PO read in DED.
 * @returns {{ materialDocument: string, materialDocumentYear: string }}
 */
export async function postGoodsReceipt ({ po, item, quantity, unit, material, plant, storageLocation, batch }) {
  if (!isPo(po) || !isItem(item)) throw new Error('Invalid PO / item number')
  const payload = {
    DocumentDate: sapDate(),
    PostingDate: sapDate(),
    GoodsMovementCode: '01',
    MaterialDocumentHeaderText: 'PVK_GR_PO',
    to_MaterialDocumentItem: [{
      Material: material,
      Plant: plant,
      StorageLocation: storageLocation || undefined,
      Batch: batch || undefined,
      GoodsMovementType: '101',
      PurchaseOrder: po,
      PurchaseOrderItem: item,
      GoodsMovementRefDocType: 'B',
      QuantityInEntryUnit: String(quantity),
      EntryUnit: unit
    }]
  }
  const data = await request({
    method: 'POST',
    url: `${MD_PATH()}/A_MaterialDocumentHeader`,
    headers: { 'Content-Type': 'application/json' },
    data: payload
  })
  const d = data?.d || data
  if (!d?.MaterialDocument) throw new Error('SAP did not return a material document number')
  return { materialDocument: d.MaterialDocument, materialDocumentYear: d.MaterialDocumentYear }
}
