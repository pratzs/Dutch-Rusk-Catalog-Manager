# Naitik route sales (Mon-Wed vs Thu-Fri)

Average sales per week for Naitik Trivedi (Worthy Products, Odoo company 4), split into his Monday-Wednesday and Thursday-Friday routes. Requested by Kishan, built 22 Oct 2026 for the FY from 1 Apr 2026.

Run (credentials in ~/.odoo-worthy.env, read only):
1. `python -I pull.py DATA/data.json` (invoices, lines, sale orders for salesperson id 45)
2. `python -I tags.py DATA/data.json DATA/partners.json`
3. `python -I build.py DATA/data.json DATA/partners.json OUT_DIR 2026-04-01 <today>` (writes Naitik_Mon-Wed_... and Naitik_Thu-Fri_..._Route_Average_Weekly_Sales_FY26.xlsx)
5. `python -I verify.py MONWED.xlsx THUFRI.xlsx 2026-04-01 <today>`: fresh Odoo re-pull, independent logic; must print FAILURES: 0
4. `python -I check.py` prints Odoo's own product total for Naitik; the two files must add up to it.

Rules: sales = posted invoices less credit notes, product lines only, ex GST (finance basis). Route = weekday the order was placed (Odoo date_order, NZ time): Mon-Wed or Thu-Fri, website orders included. Weekend orders and invoices with no sales order go to the customer's main route. Credit notes follow the order they credit for the route, and are taken off in the week they were issued. Customer route tags cannot be used: both trips are tagged "Up North". Average = full Monday-Sunday weeks only (part week of 1 Apr and the current week excluded).

Two workbooks, one per route, each: Summary (average per week first), Weekly (Week 1..N), Customers, Invoices. Kishan wants two separate files.

Output: Worthy Ecommerce - Documents\04.Worthy Products E-Commerce Project\Odoo Reports\Naitik Route Sales\
