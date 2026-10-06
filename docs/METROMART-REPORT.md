# Metromart order alert + North vs South report (Jira SUP-45)

Requested by Nish Jha (Key Account Manager, Metromart), approved 7 Oct 2026.

## Order alert
Every Metromart on the Dutch Rusk shop is a South Island store. When one places an
order, `webhooks.orders.create.jsx` emails `METROMART_ALERT_TO` using the same layout
as the sales rep order email, then stamps the order with the attribute
`Metromart Alert Sent` so a webhook retry never sends it twice. Unset = off.

## Weekly + monthly report
`app/lib/metromart-report.server.js`, started from `entry.server.jsx`.

| | When (NZ) | Period |
|---|---|---|
| Weekly | Sunday from 4pm (catch-up all Monday) | that Mon-Sun |
| Monthly | 1st from 8am (catch-up all of the 2nd) | previous calendar month |

- North Island = Odoo company 4 customers tagged `Metromart`; posted invoices less credit
  notes, product lines only, excl GST (finance basis).
- South Island = Ostendo invoiced (`SALESINVOICELINES.EXTENDEDNETTPRICE`, excl GST,
  credits already negative), delivery customer like `%METRO%MART%`, year suffixes merged.
- Each send claims a `ReportSendLog` key first, so a restart or second process never
  double-sends. If Ostendo is down the claim is released and it retries every 15 min;
  from 6pm on the catch-up day it sends North only with a clear "South missing" note.

## Settings (Render env)
`METROMART_REPORT_TO` (unset = no reports), `METROMART_ALERT_TO`, `METROMART_ALERT_NAME`
(greeting, default Nish), `METROMART_REPORT_TIMER=off` to disable, plus `ODOO_URL`,
`ODOO_DB`, `ODOO_USER`, `ODOO_PASSWORD`, `OSTENDO_BASE_URL`, `OSTENDO_API_KEY`.

## Test / preview
- `GET /api/metromart-report?secret=<CRON_SECRET>&kind=week|month` shows the HTML, sends nothing.
- `...&send=1&to=someone@x.nz` sends one test copy to that address only.
