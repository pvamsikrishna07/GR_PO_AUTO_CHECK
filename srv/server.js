import cds from '@sap/cds'
import express from 'express'
import crypto from 'node:crypto'
import path from 'node:path'

const sha = s => crypto.createHash('sha256').update(String(s)).digest()
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b))

/**
 * The app is deployed behind ONE route and has no approuter/XSUAA, so access is protected here with HTTP Basic auth.
 * Credentials come from APP_USER / APP_PASSWORD. In production the app refuses to serve without them (fail closed),
 * because it can post goods receipts into the ERP.
 */
function accessGate (req, res, next) {
  const user = process.env.APP_USER
  const pass = process.env.APP_PASSWORD
  if (!user || !pass) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).type('text/plain').send('Application is not configured: APP_USER / APP_PASSWORD are missing.')
    }
    return next() // local development
  }
  const header = req.headers.authorization || ''
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const i = decoded.indexOf(':')
    if (i > 0 && safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), pass)) return next()
  }
  res.set('WWW-Authenticate', 'Basic realm="PVK_GR_PO", charset="UTF-8"').status(401).type('text/plain').send('Authentication required')
}

function securityHeaders (req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'Cache-Control': 'no-store'
  })
  if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  next()
}

cds.on('bootstrap', app => {
  app.disable('x-powered-by')
  app.use(securityHeaders)
  app.use(accessGate)
  // single route: the UI is served by the same app that serves /gr
  app.use(express.static(path.join(import.meta.dirname, 'public')))
})
