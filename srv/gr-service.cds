/**
 * PVK_GR_PO - Goods receipt automation service.
 * Stateless: nothing is stored in a database, all master/transaction data lives in DED S/4HANA.
 */
@path: '/gr'
service GRService {

  /** S/4HANA purchase order item data used for the match. */
  type S4Info {
    plant           : String;
    storageLocation : String;
    orderQuantity   : Decimal(15, 3);
    receivedQuantity: Decimal(15, 3);
    openQuantity    : Decimal(15, 3);
    unit            : String;
    minQuantity     : Decimal(15, 3);
    maxQuantity     : Decimal(15, 3);
  }

  /** One line extracted from the PDF together with the outcome of the match. */
  type LineResult {
    lineNo   : Integer;
    po       : String;
    item     : String;
    material : String;
    quantity : Decimal(15, 3);
    uom      : String;
    status   : String; // MATCHED | NOT_MATCHED
    reason   : String;
    s4       : S4Info;
  }

  type AnalyzeResult {
    fileName  : String;
    matched   : Integer;
    unmatched : Integer;
    lines     : many LineResult;
    warnings  : many String;
  }

  type PostLine {
    po       : String;
    item     : String;
    material : String;
    quantity : Decimal(15, 3);
    uom      : String;
  }

  type PostResult {
    po                   : String;
    item                 : String;
    status               : String; // POSTED | FAILED
    materialDocument     : String;
    materialDocumentYear : String;
    message              : String;
  }

  /** Steps 1-3: read the PDF, extract the PO lines and match them against DED. */
  action analyze(fileName : String, pdfBase64 : LargeString) returns AnalyzeResult;

  /** Step 5: post goods receipts (movement type 101) for the lines the user confirmed. */
  action postGoodsReceipt(lines : many PostLine) returns many PostResult;
}
