import { canonicalUom } from './pdf-extract.js'

/** Default quantity tolerance (%) used when the PO item carries no under/over-delivery tolerance. */
export const defaultTolerancePct = () => {
  const v = Number(process.env.QTY_TOLERANCE_PCT)
  return Number.isFinite(v) && v >= 0 ? v : 5
}

const normMaterial = m => String(m ?? '').trim().toUpperCase().replace(/^0+(?=\d)/, '')
const round3 = n => Math.round(n * 1000) / 1000

/**
 * Match one extracted line against the purchase order data read from DED.
 * @param line  extracted line {po,item,material,quantity,uom}
 * @param po    {error?, items: Map<itemNo, item>} as returned by s4.readPurchaseOrder()
 * @param claimed Set of "po/item" already matched by earlier lines of the same document
 */
export function matchLine (line, po, claimed = new Set()) {
  const out = { ...line, status: 'NOT_MATCHED', reason: '', s4: null }
  const fail = reason => { out.reason = reason; return out }

  if (!line.po) return fail('PO number missing on the delivery note')
  if (!po || po.error) return fail(po?.error || `PO ${line.po} could not be read from DED`)
  if (!po.items.size) return fail(`PO ${line.po} has no items in DED`)

  let candidates
  if (line.item) {
    const it = po.items.get(line.item)
    if (!it) return fail(`PO ${line.po} has no item ${line.item} in DED`)
    candidates = [it]
  } else {
    candidates = [...po.items.values()].filter(i => normMaterial(i.material) === normMaterial(line.material))
    if (!candidates.length) return fail(`No item with material ${line.material} on PO ${line.po}`)
  }

  const reasons = []
  for (const it of candidates) {
    const r = evaluate(line, it)
    if (r.ok) {
      const key = `${line.po}/${it.item}`
      if (claimed.has(key)) { reasons.push(`PO item ${it.item} is already covered by another line of this document`); continue }
      claimed.add(key)
      out.item = it.item
      out.material = line.material || it.material
      out.status = 'MATCHED'
      out.s4 = r.s4
      return out
    }
    reasons.push(candidates.length > 1 ? `item ${it.item}: ${r.reason}` : r.reason)
    out.s4 ??= r.s4
  }
  return fail(reasons.join('; '))
}

function evaluate (line, it) {
  const received = it.receivedQuantity || 0
  const open = round3(it.orderQuantity - received)
  const underPct = it.underTolerancePct > 0 ? it.underTolerancePct : defaultTolerancePct()
  const overPct = it.overTolerancePct > 0 ? it.overTolerancePct : defaultTolerancePct()
  const s4 = {
    plant: it.plant, storageLocation: it.storageLocation, unit: it.unit,
    orderQuantity: it.orderQuantity, receivedQuantity: round3(received), openQuantity: open,
    minQuantity: round3(Math.max(open, 0) * (1 - underPct / 100)),
    maxQuantity: round3(Math.max(open, 0) * (1 + overPct / 100))
  }
  const bad = reason => ({ ok: false, reason, s4 })

  if (it.deleted) return bad('PO item is deleted/blocked in DED')
  if (it.completelyDelivered) return bad('PO item is already marked as completely delivered')
  if (line.material && it.material && normMaterial(line.material) !== normMaterial(it.material)) {
    return bad(`material mismatch (PDF ${line.material}, PO ${it.material})`)
  }
  if (canonicalUom(line.uom) !== canonicalUom(it.unit)) return bad(`unit mismatch (PDF ${line.uom}, PO ${it.unit})`)
  if (open <= 0) return bad(`PO item is already fully received (ordered ${it.orderQuantity}, received ${round3(received)})`)
  if (line.quantity < s4.minQuantity || line.quantity > s4.maxQuantity) {
    return bad(`quantity ${line.quantity} outside tolerance ${s4.minQuantity} - ${s4.maxQuantity} (open ${open} ${it.unit})`)
  }
  return { ok: true, s4 }
}

/** Match all lines of a document. poMap: Map<poNumber, {error?, items}> */
export function matchAll (lines, poMap) {
  const claimed = new Set()
  return lines.map(l => matchLine(l, poMap.get(l.po), claimed))
}
