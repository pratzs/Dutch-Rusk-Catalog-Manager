# Ostendo paid → Shopify paid

B2B orders arrive in Shopify as **Payment pending** (account terms). Dutch Rusk raises the invoice and records the payment in Ostendo, so until 19 Nov 2026 every order showed unpaid in Shopify and in the customer's account, and customers complained.

`app/lib/ostendo-paid-sync.server.js` runs inside the web service every 15 minutes (first run 90 s after start-up) and marks a Shopify order paid once Ostendo has it paid. It only reads Ostendo.

## How an order is matched

| Ostendo | Meaning |
|---|---|
| `SALESHEADER.ADDITIONALFIELD_4` | Shopify order id (numeric). Set by the Shopify connector (XQS), and by staff who key an online order in by hand |
| `SALESINVOICEHEADER.GROUPORDERNUMBERS` | The sales order number(s) the invoice is for |
| `SALESINVOICEHEADER.INVOICESTATUS`, `BALANCEDUE` | `Fully Paid` and 0 when paid |

An order is marked paid only when it is not cancelled, its Ostendo sales order is **Closed**, it has at least one invoice (credits and reversed invoices ignored), and **every** invoice is Fully Paid with no balance. Short shipments are still marked paid: Ostendo is the ledger.

Left unpaid on purpose:
- invoice still owing (most accounts are 20th of the month following)
- sales order not Closed yet
- no invoice on the sales order. This is usually an order a rep re-keyed under a new order number; nothing links that invoice back to the Shopify order, so it is not guessed
- no Ostendo sales order with that Shopify id

## Switches (Render env on Dutch-Rusk-Catalog-Manager)

- `OSTENDO_PAID_SYNC=off`: does not run. `=dry`: logs what it would mark, marks nothing.
- `OSTENDO_PAID_SYNC_INTERVAL_MIN` (default 15).
- Needs `OSTENDO_BASE_URL` and `OSTENDO_API_KEY` (already set for the Metromart report).

## Checking it

Every run logs `[ostendo-paid] <source>: start`, then `checked N unpaid, marked M paid, F failed {...counts by reason}` and the order numbers marked. Search the Render log for `[ostendo-paid]`; a missing summary line after a `start` line means the run failed.

## Limits

The app can only see orders from the last 60 days (no `read_all_orders` scope), so older orders are not covered by the timer.

## History

- 19 Nov 2026: one-off pass marked 199 orders paid (list in OneDrive `Ostendo Reports/Shopify Paid Status`). Timer added the same day.
