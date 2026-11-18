import cds from '@sap/cds'
import { extractFromPdf } from './lib/pdf-extract.js'
import { matchAll, matchLine } from './lib/matcher.js'
import { readPurchaseOrder, postGoodsReceipt, sapMessage } from './lib/s4.js'

const MAX_PDF_BYTES = 10 * 1024 * 1024
const MAX_POST_LINES = 200
const LOG = cds.log('gr')

export default class GRService extends cds.ApplicationService {
  init () {
    this.on('analyze', async req => {
      const { fileName, pdfBase64 } = req.data
      if (!pdfBase64) return req.reject(400, 'No PDF uploaded')
      const buffer = Buffer.from(pdfBase64, 'base64')
      if (buffer.length > MAX_PDF_BYTES) return req.reject(413, 'PDF is larger than 10 MB')
      if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return req.reject(400, 'The uploaded file is not a PDF')

      let extracted
      try {
        extracted = await extractFromPdf(buffer)
      } catch (e) {
        LOG.warn('PDF could not be read', e.message)
        return req.reject(422, 'The PDF could not be read (damaged or password protected?)')
      }

      // read every referenced PO once from DED
      const poNumbers = [...new Set(extracted.lines.map(l => l.po).filter(Boolean))]
      const poMap = new Map()
      for (const po of poNumbers) poMap.set(po, await readPurchaseOrder(po))

      const lines = matchAll(extracted.lines, poMap).map(({ sourceText, ...l }) => l)
      const matched = lines.filter(l => l.status === 'MATCHED').length
      LOG.info(`analyzed ${JSON.stringify(String(fileName || '').slice(0, 80))}: ${lines.length} lines, ${matched} matched`)
      return { fileName, matched, unmatched: lines.length - matched, lines, warnings: extracted.warnings }
    })

    this.on('postGoodsReceipt', async req => {
      const requested = req.data.lines || []
      if (!requested.length) return req.reject(400, 'Nothing to post')
      if (requested.length > MAX_POST_LINES) return req.reject(400, `At most ${MAX_POST_LINES} lines can be posted at once`)

      // never trust the browser: re-read the PO from DED and re-run the match before posting
      const poMap = new Map()
      for (const po of new Set(requested.map(l => l.po))) poMap.set(po, await readPurchaseOrder(po))

      const claimed = new Set()
      const results = []
      for (const line of requested) {
        const base = { po: line.po, item: line.item }
        const m = matchLine({ ...line, quantity: Number(line.quantity) }, poMap.get(line.po), claimed)
        if (m.status !== 'MATCHED') {
          results.push({ ...base, status: 'FAILED', message: `Not posted: ${m.reason}` })
          continue
        }
        const it = poMap.get(line.po).items.get(m.item)
        try {
          const doc = await postGoodsReceipt({
            po: line.po, item: m.item, quantity: Number(line.quantity), unit: it.unit,
            material: it.material, plant: it.plant, storageLocation: it.storageLocation, batch: it.batch
          })
          LOG.info(`GR posted for ${line.po}/${m.item}: ${doc.materialDocument}/${doc.materialDocumentYear}`)
          results.push({ ...base, item: m.item, status: 'POSTED', ...doc, message: 'Goods receipt posted' })
        } catch (e) {
          LOG.error(`GR failed for ${line.po}/${m.item}`, sapMessage(e))
          results.push({ ...base, item: m.item, status: 'FAILED', message: sapMessage(e) })
        }
      }
      return results
    })

    return super.init()
  }
}
