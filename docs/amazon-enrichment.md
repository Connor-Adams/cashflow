# Amazon Transaction Enrichment

Amazon enrichment turns Amazon card transactions into item-level expense records that can be categorized and reviewed.

## Importing a Report

Open **Amazon** in the app and upload an Amazon report CSV. The importer accepts flexible column names for order IDs, dates, item titles, quantities, prices, totals, currency, and card last four digits.

Re-uploading the same file is safe. Orders dedupe by Amazon order ID when present. When no order ID exists, the fallback key is vendor, order/shipment date, total, and a normalized item-title hash.

The import summary reports:

- orders created
- orders skipped
- failed rows
- imported item count

## Matching

Use **Run matching** on the Amazon page. Matching scans Amazon-like card transactions whose merchant contains values such as `AMAZON`, `AMAZON.CA`, `AMZN`, `AMZN MKTP`, `AMZN Mktp CA`, `Amazon Marketplace`, or `Prime`.

Candidate orders are scored deterministically:

- `+50` amount within `$0.50`
- `+35` amount within `$2.00`
- `+25` order or shipment date is 0-5 days before the transaction date
- `+15` merchant indicates Amazon
- `+20` payment last four matches when available
- `-25` total mismatch over `$2.00`
- `-15` date gap over 10 days

Confidence is capped at 0-100. Scores 90+ are high, 70-89 are medium, and below 70 are low. Low matches are only suggested when there is no better candidate.

The matching model supports many-to-many links. One Amazon order can map to multiple card charges, and multiple Amazon orders can map to one card charge.

## Review Workflow

The Amazon Review section lists Amazon-like transactions with suggested orders, item previews, confidence, and match reason. You can:

- accept a suggestion
- reject a suggestion
- manually link an order
- unlink an existing link
- open an order detail view
- edit item title, category, business use percentage, and amount

## Categorization

Item categories use a deterministic keyword fallback at import time. If OpenAI is configured, the Amazon page also offers **AI categorize** actions that use the imported item titles, prices, order metadata, existing category hints, and current fallback category to update item categories and business-use percentages.

Supported categories:

- Office Equipment
- Software
- Meals & Groceries
- Household
- Travel
- Medical
- Personal
- Uncategorized

Examples include USB-C cables, monitors, and keyboards as Office Equipment; protein, coffee, and snacks as Meals & Groceries; detergent and cleaning supplies as Household; and toothpaste as Personal.

AI categorization is optional. The deterministic fallback still works without paid AI, Amazon login, or Gmail access.

## Known Limitations

- No Amazon login or browser extension.
- Email parsing is best-effort and not connected to Gmail OAuth yet.
- PDF parsing is not implemented.
- Matching is deterministic and may require manual review for split shipments, delayed charges, refunds, gift cards, or partial authorizations.
- Card last four matching only applies when the source data contains it.

## Roadmap

- Forwarded receipt inbox
- Gmail OAuth receipt import
- PDF parser
- Amazon Business report support
