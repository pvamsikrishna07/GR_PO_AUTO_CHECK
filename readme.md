# PVK_GR_PO

SAP CAP application that creates goods receipts in DED S/4HANA from a delivery note PDF.

1. Upload a delivery note / shipping notice (PDF).
2. PO number, PO item, material, quantity and UoM are extracted.
3. The lines are matched against the purchase orders in DED (BTP destination `DED_HTTP_200`) within quantity tolerance.
4. The matched PO items are listed and the user confirms.
5. Goods receipts (movement type 101) are posted and the GR document number per PO item is shown.

Deployment is automatic: every push to `main` runs `.github/workflows/deploy-btp.yml` (tests, MTA build, `cf deploy`).
See [CLAUDE.md](CLAUDE.md) for architecture, matching rules, required repository secrets and local development.
