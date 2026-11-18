import { PDFParse } from 'pdf-parse'

/** Units that count "pieces" - treated as interchangeable when comparing with the PO unit. */
const PIECE_UNITS = ['PC', 'PCS', 'PCE', 'PIECE', 'PIECES', 'EA', 'EACH', 'ST', 'STK', 'UNIT', 'UNITS', 'NOS']
const UOM_ALIASES = {
  KGM: 'KG', KILOGRAM: 'KG', KILOGRAMS: 'KG', KGS: 'KG',
  GRM: 'G', GRAM: 'G', GRAMS: 'G',
  LTR: 'L', LITER: 'L', LITRE: 'L', LITERS: 'L', LITRES: 'L',
  MTR: 'M', METER: 'M', METRE: 'M', METERS: 'M', METRES: 'M',
  CMT: 'CM', MMT: 'MM',
  CARTON: 'KAR', CTN: 'KAR', CARTONS: 'KAR',
  PALLET: 'PAL', PALLETS: 'PAL', PLT: 'PAL',
  PACK: 'PAK', PKG: 'PAK', PACKS: 'PAK',
  BOXES: 'BOX', BX: 'BOX',
  LBS: 'LB', POUND: 'LB', POUNDS: 'LB'
}
const KNOWN_UOMS = new Set([
  ...PIECE_UNITS, ...Object.keys(UOM_ALIASES),
  'KG', 'G', 'MG', 'T', 'LB', 'L', 'ML', 'M', 'CM', 'MM', 'KM', 'M2', 'M3', 'BOX', 'KAR', 'PAL', 'PAK', 'SET', 'ROL', 'DR', 'BAG', 'CAN', 'PR', 'DZ', 'HR'
])

/** Canonical key for comparing units of measure (not the SAP unit - that always comes from the PO). */
export function canonicalUom (uom) {
  const u = String(uom || '').toUpperCase().replace(/\./g, '').trim()
  if (PIECE_UNITS.includes(u)) return 'PC'
  return UOM_ALIASES[u] || u
}

/**
 * Parse a quantity as printed on a delivery note.
 * Handles 1,234.50 / 1.234,50 / 10,5 / 10.000 (= 10 with three zero decimals) / 1,250 (= 1250 thousands).
 */
export function parseQuantity (raw) {
  let s = String(raw).trim()
  if (!/^\d[\d.,]*$/.test(s)) return NaN
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = Math.max(lastDot, lastComma)
    const decSep = s[dec]
    const thousandsSep = decSep === '.' ? ',' : '.'
    s = s.split(thousandsSep).join('')
    s = decSep === ',' ? s.replace(',', '.') : s
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ','
    const parts = s.split(sep)
    const after = parts[parts.length - 1]
    if (parts.length > 2) {
      s = parts.join('') // 1,250,000 -> thousands separators only
    } else if (after.length === 3 && after !== '000' && parts[0] !== '0' && parts[0].length <= 3) {
      s = parts.join('') // 1,250 -> 1250
    } else {
      s = parts.join('.') // 10,5 / 0,500 / 10.000 -> decimal
    }
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : NaN
}

export async function pdfToText (buffer) {
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const result = await parser.getText()
    return result.text || ''
  } finally {
    await parser.destroy().catch(() => {})
  }
}

const PO_LABELED = /(?:\bP\.?\s?O\.?\b|purchase\s*order|order\s*(?:no|number|nr|#)\.?|customer\s*order|your\s*(?:order|ref(?:erence)?))[^\dA-Za-z]{0,12}(\d{10})\b/i
const PO_UNLABELED = /\b(4[05]\d{8})\b/
const NUM_UOM_GLUED = /^(\d[\d.,]*)([A-Za-z]{1,6})$/

const padItem = n => String(n).replace(/\D/g, '').padStart(5, '0')

function tokenize (line) {
  const out = []
  for (const t of line.split(/[\t ]+/).filter(Boolean)) {
    const glued = NUM_UOM_GLUED.exec(t)
    if (glued && KNOWN_UOMS.has(glued[2].toUpperCase())) out.push(glued[1], glued[2])
    else out.push(t)
  }
  return out
}

function parseTableRow (line, ctxPo) {
  const tokens = tokenize(line)
  // quantity + unit: a number directly followed by a known unit
  let q = -1
  for (let i = 0; i < tokens.length - 1; i++) {
    if (/^\d[\d.,]*$/.test(tokens[i]) && KNOWN_UOMS.has(tokens[i + 1].toUpperCase().replace(/\.$/, ''))) q = i
  }
  if (q < 0) return null
  const quantity = parseQuantity(tokens[q])
  if (!Number.isFinite(quantity) || quantity <= 0) return null
  const uom = tokens[q + 1].toUpperCase().replace(/\.$/, '')

  let po = null
  let item = null
  const used = new Set([q, q + 1])
  tokens.forEach((t, i) => {
    if (used.has(i)) return
    let m = /^(\d{10})[/\-:](\d{1,5})$/.exec(t)
    if (m && !po) { po = m[1]; item = padItem(m[2]); used.add(i); return }
    m = /^\d{10}$/.exec(t)
    if (m && !po) { po = t; used.add(i) }
  })
  if (!po) po = ctxPo

  if (!item) {
    const idx = tokens.findIndex((t, i) => !used.has(i) && i < q && (/^\d{5}$/.test(t) || (/^\d{1,5}$/.test(t) && Number(t) % 10 === 0 && Number(t) > 0)))
    if (idx >= 0) { item = padItem(tokens[idx]); used.add(idx) }
  }

  let material = null
  const mIdx = tokens.findIndex((t, i) => !used.has(i) && i < q + 2 && /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9\-_/.]{2,39}$/.test(t) && !/^\d{1,5}$/.test(t))
  if (mIdx >= 0) material = tokens[mIdx].toUpperCase()

  if (!item && !material) return null
  return { po, item, material, quantity, uom, sourceText: line.trim().slice(0, 300) }
}

/** Fallback for "label: value" style delivery notes without a table. */
function parseLabeled (lines, ctxPo) {
  const records = []
  let cur = {}
  let po = ctxPo
  const flush = () => {
    if (cur.quantity && (cur.item || cur.material)) records.push({ po: cur.po || po, item: cur.item || null, material: cur.material || null, quantity: cur.quantity, uom: cur.uom, sourceText: (cur.src || []).join(' | ').slice(0, 300) })
    cur = {}
  }
  const set = (k, v, line) => {
    if (cur[k] != null) flush()
    cur[k] = v
    ;(cur.src ||= []).push(line.trim())
  }
  for (const line of lines) {
    let m
    if ((m = PO_LABELED.exec(line))) { po = m[1]; if (cur.po && cur.po !== po) flush(); cur.po = po }
    if ((m = /\b(?:po\s*item|item|line)(?:\s*(?:no|number|nr))?\.?\s*[:#-]?\s*(\d{1,5})\b/i.exec(line)) && !/material|qty/i.test(m[0])) set('item', padItem(m[1]), line)
    if ((m = /\b(?:material|part|article|product|sku)(?:\s*(?:no|number|nr|code))?\.?\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\-_/.]{2,39})\b/i.exec(line))) set('material', m[1].toUpperCase(), line)
    if ((m = /\b(?:quantity|qty|shipped|delivered)\.?\s*[:#-]?\s*(\d[\d.,]*)\s*([A-Za-z]{1,6})\b/i.exec(line)) && KNOWN_UOMS.has(m[2].toUpperCase())) {
      const q = parseQuantity(m[1])
      if (Number.isFinite(q) && q > 0) { set('quantity', q, line); cur.uom = m[2].toUpperCase() }
    }
  }
  flush()
  return records
}

/**
 * Turn the text of a delivery note / shipping notice into PO lines.
 * @returns {{ lines: Array, warnings: string[] }}
 */
export function parseDeliveryNote (text) {
  const warnings = []
  const rawLines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(l => l.trim())
  let ctxPo = null
  const rows = []
  for (const line of rawLines) {
    const labeled = PO_LABELED.exec(line)
    const unlabeled = PO_UNLABELED.exec(line)
    const row = parseTableRow(line, ctxPo)
    if (row) {
      if (!row.po && (labeled || unlabeled)) row.po = (labeled || unlabeled)[1]
      rows.push(row)
    } else if (labeled) ctxPo = labeled[1]
    else if (unlabeled) ctxPo = unlabeled[1]
  }
  let lines = rows
  if (!lines.length) {
    lines = parseLabeled(rawLines, ctxPo)
    if (lines.length) warnings.push('No item table was recognised; the lines were read from labelled fields. Please review them carefully.')
  }
  lines = lines.map((l, i) => ({ lineNo: i + 1, ...l }))
  if (!lines.length) warnings.push('No PO lines (PO, item, material, quantity, UoM) could be extracted from this PDF. Scanned/image-only PDFs are not supported.')
  for (const l of lines) {
    if (!l.po) warnings.push(`Line ${l.lineNo}: no PO number found.`)
    if (!l.item && !l.material) warnings.push(`Line ${l.lineNo}: neither PO item nor material found.`)
  }
  return { lines, warnings }
}

export async function extractFromPdf (buffer) {
  const text = await pdfToText(buffer)
  return { text, ...parseDeliveryNote(text) }
}
