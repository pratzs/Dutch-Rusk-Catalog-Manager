# Pulling old-site (dr-admin) orders

Needs Pratham's own logged-in Chrome (claude-in-chrome). Read-only GETs.

1. Navigate a tab to `https://www.dutchrusk.co.nz/dr-admin/ordering/order/?created_at__gte=YYYY-MM-DD`.
2. In the page, page through `?created_at__gte=...&p=N` (100 rows each) reading `#result_list tbody tr` into `window.__o` (id, user, customer group, status, created at). The paginator count must equal the row count (2,793 for 1 Apr to 14 Oct 2026).
3. Fetch each `/dr-admin/ordering/order/<id>/change/` and regex `Total:\s*([\d.,]+)` for the order total (ex GST, equals the Ostendo invoice net when synced as is). About 6 per second with 5 workers; the evaluate call times out at 45 s, so start the workers without awaiting and poll.
4. Tool output is truncated to about 1 KB, so send the rows to the PC: run `python -I recv_local.py OUT/oldsite.txt` (listens on 127.0.0.1:8765) and POST `id|user|cust|status|created|total` lines from the page with `fetch('http://127.0.0.1:8765/', {method:'POST', body})`. Chrome shows a local network access prompt: Pratham must click Allow. Kill the listener after.
5. Save as `DATA_DIR/oldsite.txt` and run build_rep_reports.py.

The order "User" is a store login slug (nnd.regent, tz.hereford). There is no slug-to-store table; the build learns it from exact-amount matches.
