// PVK_GR_PO UI - plain JS, no inline scripts (CSP), every value from the PDF/ERP is inserted as text.
const $ = id => document.getElementById(id)
const MAX_BYTES = 10 * 1024 * 1024
let analysis = null

function el (tag, props = {}, ...children) {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v
    else if (k === 'checked' || k === 'disabled') n[k] = v
    else n.setAttribute(k, v)
  }
  for (const c of children) n.append(c instanceof Node ? c : String(c ?? ''))
  return n
}
const fmt = n => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }))

function step (n) {
  ;[1, 2, 3].forEach(i => {
    $('st' + i).classList.toggle('active', i === n)
    $('st' + i).classList.toggle('done', i < n)
  })
}
function busy (text) { $('busy').hidden = !text; if (text) $('busyText').textContent = text }
function showError (msg) { $('error').hidden = !msg; $('error').textContent = msg || '' }

async function callAction (name, body) {
  const res = await fetch('/gr/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  })
  let data = null
  try { data = await res.json() } catch { /* not json */ }
  if (!res.ok) throw new Error(data?.error?.message || `Request failed (HTTP ${res.status})`)
  return data
}

function toBase64 (file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(new Error('The file could not be read'))
    r.readAsDataURL(file)
  })
}

async function handleFile (file) {
  showError('')
  if (!file) return
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return showError('Please choose a PDF file.')
  if (file.size > MAX_BYTES) return showError('The PDF is larger than 10 MB.')
  $('fileName').hidden = false
  $('fileName').textContent = `${file.name} (${Math.round(file.size / 1024)} KB)`
  $('upload').hidden = true
  busy('Reading the PDF and checking purchase orders in DED…')
  try {
    analysis = await callAction('analyze', { fileName: file.name, pdfBase64: await toBase64(file) })
    renderReview()
  } catch (e) {
    showError(e.message)
    $('upload').hidden = false
    step(1)
  } finally {
    busy('')
  }
}

function headRow (cols) {
  return el('thead', {}, el('tr', {}, ...cols.map(c => el('th', c.num ? { class: 'num' } : {}, c.label))))
}

function renderReview () {
  step(2)
  $('review').hidden = false
  $('result').hidden = true
  const matched = analysis.lines.filter(l => l.status === 'MATCHED')
  const unmatched = analysis.lines.filter(l => l.status !== 'MATCHED')

  const sum = $('summary'); sum.replaceChildren(
    el('span', { class: 'pill' }, `${analysis.lines.length} line(s) read`),
    el('span', { class: 'pill ok' }, `${matched.length} matched`),
    el('span', { class: unmatched.length ? 'pill bad' : 'pill' }, `${unmatched.length} not matched`)
  )
  const w = $('warnings'); w.replaceChildren(...(analysis.warnings || []).map(t => el('li', {}, t))); w.hidden = !(analysis.warnings || []).length

  const mt = $('matchedTable'); mt.replaceChildren(
    headRow([{ label: '' }, { label: 'PO' }, { label: 'Item' }, { label: 'Material' }, { label: 'Qty (PDF)', num: 1 }, { label: 'UoM' }, { label: 'Open qty (DED)', num: 1 }, { label: 'Tolerance range', num: 1 }, { label: 'Plant / SLoc' }]),
    el('tbody', {}, ...matched.map((l, i) => el('tr', {},
      el('td', {}, el('input', { type: 'checkbox', checked: true, 'data-i': i, 'aria-label': `Post PO ${l.po} item ${l.item}` })),
      el('td', {}, l.po), el('td', {}, l.item), el('td', {}, l.material),
      el('td', { class: 'num' }, fmt(l.quantity)), el('td', {}, l.uom),
      el('td', { class: 'num' }, `${fmt(l.s4.openQuantity)} ${l.s4.unit}`),
      el('td', { class: 'num' }, `${fmt(l.s4.minQuantity)} – ${fmt(l.s4.maxQuantity)}`),
      el('td', {}, [l.s4.plant, l.s4.storageLocation].filter(Boolean).join(' / '))
    )))
  )
  mt.hidden = !matched.length
  $('noMatched').hidden = matched.length > 0

  const ub = $('unmatchedBox'); ub.hidden = !unmatched.length; ub.open = !matched.length
  $('unmatchedCount').textContent = unmatched.length
  $('unmatchedTable').replaceChildren(
    headRow([{ label: 'PO' }, { label: 'Item' }, { label: 'Material' }, { label: 'Qty', num: 1 }, { label: 'UoM' }, { label: 'Reason' }]),
    el('tbody', {}, ...unmatched.map(l => el('tr', {},
      el('td', {}, l.po), el('td', {}, l.item), el('td', {}, l.material),
      el('td', { class: 'num' }, fmt(l.quantity)), el('td', {}, l.uom), el('td', { class: 'wrap-text' }, l.reason)
    )))
  )
  mt.onchange = updatePostButton
  updatePostButton()
}

const selected = () => {
  const matched = analysis.lines.filter(l => l.status === 'MATCHED')
  return [...$('matchedTable').querySelectorAll('input[type=checkbox]:checked')].map(c => matched[Number(c.dataset.i)])
}
function updatePostButton () { $('post').disabled = !analysis || selected().length === 0 }

$('post').addEventListener('click', () => {
  const sel = selected()
  if (!sel.length) return
  const pos = new Set(sel.map(l => l.po)).size
  $('confirmText').textContent = `Post goods receipt (movement type 101) in DED for ${sel.length} PO line item(s) on ${pos} purchase order(s)? This creates material documents and cannot be undone from this app.`
  $('confirm').showModal()
})

$('confirm').addEventListener('close', async () => {
  if ($('confirm').returnValue !== 'ok') return
  const sel = selected()
  showError('')
  $('post').disabled = true
  $('review').hidden = true
  busy('Posting goods receipts in DED…')
  try {
    const data = await callAction('postGoodsReceipt', {
      lines: sel.map(l => ({ po: l.po, item: l.item, material: l.material, quantity: l.quantity, uom: l.uom }))
    })
    renderResult(data.value || [])
  } catch (e) {
    showError(e.message + ' — some goods receipts may already have been posted; check DED before retrying.')
    $('review').hidden = false
    updatePostButton()
  } finally {
    busy('')
  }
})

function renderResult (rows) {
  step(3)
  $('result').hidden = false
  const ok = rows.filter(r => r.status === 'POSTED').length
  $('resultSummary').replaceChildren(
    el('span', { class: 'pill ok' }, `${ok} posted`),
    el('span', { class: rows.length - ok ? 'pill bad' : 'pill' }, `${rows.length - ok} failed`)
  )
  $('resultTable').replaceChildren(
    headRow([{ label: 'PO' }, { label: 'Item' }, { label: 'Status' }, { label: 'GR document' }, { label: 'Year' }, { label: 'Message' }]),
    el('tbody', {}, ...rows.map(r => el('tr', {},
      el('td', {}, r.po), el('td', {}, r.item),
      el('td', {}, el('span', { class: r.status === 'POSTED' ? 'pill ok' : 'pill bad' }, r.status)),
      el('td', {}, r.materialDocument), el('td', {}, r.materialDocumentYear), el('td', { class: 'wrap-text' }, r.message)
    )))
  )
}

function reset () {
  analysis = null
  showError('')
  $('review').hidden = true
  $('result').hidden = true
  $('upload').hidden = false
  $('fileName').hidden = true
  $('file').value = ''
  step(1)
}
$('restart').addEventListener('click', reset)
$('again').addEventListener('click', reset)

const drop = $('drop')
$('file').addEventListener('change', e => handleFile(e.target.files[0]))
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click() } })
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over') })
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over') })
drop.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]))
