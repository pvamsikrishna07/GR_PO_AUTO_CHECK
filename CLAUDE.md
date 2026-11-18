# CLAUDE.md - PVK_GR_PO

SAP CAP (Node.js, ESM) application **PVK_GR_PO**. A user uploads a delivery note / shipping notice PDF; the app extracts
PO number, PO item, material, quantity and UoM, matches them against purchase orders in DED S/4HANA (destination
`DED_HTTP_200`, client 200) within quantity tolerance, asks the user to confirm, then posts goods receipts
(movement type 101) and lists the GR document numbers per PO line item.

## Working rules (always follow)
1. **Keep this CLAUDE.md up to date** whenever behaviour, structure, secrets or the workflow change.
2. **Always commit and push every change to `origin` (`main`)** of https://github.com/pvamsikrishna07/GR_PO_AUTO_CHECK.
   Never deploy to BTP from a laptop - the GitHub Actions workflow deploys every push to `main`.
3. Run `npm test` before pushing. The workflow also runs it and will not deploy on failure.
4. **Single route only**: one Node.js module (`PVK_GR_PO-srv`) serves the UI (`/`) and the service (`/gr`). Do not add an
   approuter, a second app or a second route.
5. Never commit secrets (`.env`, `deploy.mtaext`, passwords, keys). Never print the private SSH key.
6. Posting is a write to the ERP: always keep the explicit user confirmation step and the server-side re-validation
   in `postGoodsReceipt`.

## Git access
- Remote uses the SSH host alias `github-gr-po-auto-check` (in `~/.ssh/config`) with the dedicated deploy key
  `~/.ssh/gr_po_auto_check_ed25519` (fingerprint `SHA256:r2wRdnhA/n0+SVJDxcUK1HJJMGJuTQG8okCHW8m9SUA`, write access).
  Remote URL: `git@github-gr-po-auto-check:pvamsikrishna07/GR_PO_AUTO_CHECK.git`.

## Structure
| Path | Purpose |
|---|---|
| `srv/gr-service.cds` | Service `GRService` at `/gr`: actions `analyze` and `postGoodsReceipt` (stateless, no DB) |
| `srv/gr-service.js` | Handlers. `analyze` = extract + match; `postGoodsReceipt` re-reads DED, re-matches, then posts |
| `srv/lib/pdf-extract.js` | PDF text (pdf-parse) -> lines `{po,item,material,quantity,uom}`; table parser + label fallback |
| `srv/lib/matcher.js` | Matching rules and quantity tolerance |
| `srv/lib/s4.js` | DED access through the BTP destination (SAP Cloud SDK): read PO items, net received qty, post GR |
| `srv/server.js` | Express bootstrap: security headers, Basic-auth gate, static UI from `srv/public/` |
| `srv/public/` | UI (index.html, app.js, app.css) - no inline scripts (CSP), all values inserted as text |
| `test/` | `mock-s4.js` (fake DED), `gr.test.js` (parser), `e2e.test.js` (real server + mock DED) |
| `mta.yaml` | One module `PVK_GR_PO-srv`, services `destination` + `connectivity` (lite), single route |
| `.github/workflows/deploy-btp.yml` | Test, `mbt build`, `cf8 deploy` to BTP Cloud Foundry on push to `main` |

## DED integration
- Destination: `DED_HTTP_200` (BTP subaccount destination; must have `sap-client=200` if not in the URL; on-premise
  destinations additionally use the bound connectivity service / Cloud Connector).
- Purchase order items (OData V4): `/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001/PurchaseOrder('<po>')/_PurchaseOrderItem`
- Received quantities and GR posting (OData V2): `/sap/opu/odata/sap/API_MATERIAL_DOCUMENT_SRV/` -
  `A_MaterialDocumentItem` (net of 101 minus 102) and `POST A_MaterialDocumentHeader` (`GoodsMovementCode 01`,
  `GoodsMovementType 101`, `GoodsMovementRefDocType B`). CSRF handling is done by the Cloud SDK.
- Paths can be overridden with `S4_PO_PATH` / `S4_MATDOC_PATH`; destination name with `S4_DESTINATION`.
- Both OData paths were taken from the `mcp-sap-grn` connection test; field names are the standard released API fields.

## Matching rules (`matcher.js`)
A line is MATCHED when: PO exists and the item exists (or, without item, exactly one item has the material); item not
deleted / not completely delivered; material equals PO material (leading zeros ignored); UoM equivalent to the PO unit
(PC/PCS/EA/ST are treated as the same); and quantity is within `[open * (1 - under%), open * (1 + over%)]` where
`open = order qty - net received (101 - 102)` and the percentages are the PO item's under/over-delivery tolerance, or
`QTY_TOLERANCE_PCT` (default 5) when the PO item has none. One PO item can be claimed by only one line per document.

## Runtime configuration (env, set by `mta.yaml` / workflow)
`NODE_ENV=production`, `S4_DESTINATION`, `QTY_TOLERANCE_PCT`, `APP_USER`, `APP_PASSWORD`.
Without `APP_USER`/`APP_PASSWORD` the app answers 503 in production (fail closed) - there is no approuter/XSUAA
because of the single-route requirement, so HTTP Basic auth protects UI and service.

## GitHub repository secrets used by the workflow
`CF_API`, `CF_ORG`, `CF_SPACE`, `CF_USERNAME`, `CF_PASSWORD` (BTP Cloud Foundry login) and `APP_USER`, `APP_PASSWORD`
(app access). The CF_* names were confirmed against the repo's existing secrets; APP_USER/APP_PASSWORD were added by the user on 2026-11-18. The workflow's first step fails with the list of missing names - if your existing secrets are named
differently, change the `env:` block at the top of `deploy-btp.yml`.

## Commands
```bash
npm ci
npm test                 # unit + e2e against the mock DED
npm run mock-s4          # fake DED on :4010
destinations='[{"name":"DED_HTTP_200","url":"http://127.0.0.1:4010"}]' npx cds-serve   # app on :4004
```

## Known limits
- Text-based PDFs only (no OCR). Parsing is heuristic: table rows or `Label: value` fields; always review the list.
- Not yet validated against live DED from BTP - first deployment should be smoke-tested with a real PO.
