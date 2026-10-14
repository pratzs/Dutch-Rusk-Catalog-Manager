#!/bin/sh
# Pulls every non-reversed Ostendo invoice/credit header to OUT/hdr.json.
# Needs OSTENDO_BASE_URL and OSTENDO_API_KEY (see C:\Users\PrathamJani\worthy-dashboard\.env.local).
# Usage: set -a; . worthy-dashboard/.env.local; set +a; sh pull_ostendo.sh OUT_DIR
curl -sk -X POST "$OSTENDO_BASE_URL/sqlquery?apikey=$OSTENDO_API_KEY&format=json" -H "Content-Type: text/plain" --max-time 300 \
  --data "SELECT INVOICENUMBER,INVOICEDATE,INVOICEORCREDIT,SALESPERSON,CUSTOMER,DELIVERYCUSTOMER,BILLINGCITY,INVOICENETTAMOUNT,GROUPORDERNUMBERS,SYSUSERCREATED,SITENAME FROM SALESINVOICEHEADER WHERE INVOICEREVERSED=0" \
  -o "$1/hdr.json"
