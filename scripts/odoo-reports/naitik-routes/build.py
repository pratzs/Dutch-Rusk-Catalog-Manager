"""Naitik Trivedi (Worthy Products, Odoo company 4): average sales per week, Mon-Wed route vs Thu-Fri route.
usage: python -I build.py data.json partners.json OUT_DIR FY_START TODAY
Sales = posted customer invoices less credit notes, product lines only, ex GST (finance basis, same as the
Worthy Digital dashboard). Salesperson on the invoice = Naitik Trivedi."""
import json, sys, os, collections, datetime as dt
from zoneinfo import ZoneInfo
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

D = json.load(open(sys.argv[1])); P = {p["id"]: p for p in json.load(open(sys.argv[2]))["partners"]}
OUT = sys.argv[3]; FY0 = dt.date.fromisoformat(sys.argv[4]); TODAY = dt.date.fromisoformat(sys.argv[5])
NZ = ZoneInfo("Pacific/Auckland")
SO = {s["name"]: s for s in D["sos"]}
SALES = collections.defaultdict(float)
for l in D["lines"]:
    if l["product_id"]: SALES[l["move_id"][0]] += -l["balance"]

def nzdate(s): return dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc).astimezone(NZ).date()
MW, TF, NR = "Monday to Wednesday", "Thursday to Friday", "Not on a route"
rows = []
HAS_PRODUCT = {l["move_id"][0] for l in D["lines"] if l["product_id"]}
for m in D["moves"]:
    if m["id"] not in HAS_PRODUCT: continue   # no product lines = not a sale (finance basis)
    o = m["invoice_origin"] or ""; s = SO.get(o)
    r = {"inv": m["name"], "type": "Credit note" if m["move_type"] == "out_refund" else "Invoice", "inv_date": dt.date.fromisoformat(m["invoice_date"]),
         "cust": m["partner_shipping_id"][1], "cust_id": m["partner_shipping_id"][0], "amt": round(SALES[m["id"]], 2), "origin": o,
         "online": o.startswith("ONLINE_"), "order_date": nzdate(s["date_order"]) if s else None}
    wd = r["order_date"].weekday() if r["order_date"] else None
    if s and wd is not None and wd < 5:
        r["route"] = MW if wd < 3 else TF
        r["basis"] = f"{'Website order placed' if r['online'] else 'Order taken'} on a {r['order_date']:%A}"
    else:
        r["route"] = None
        r["basis"] = "Weekend order" if s else "No sales order on the invoice"
    rows.append(r)
# customer's main route = the route where most of their weekday orders ($) were placed
main = collections.defaultdict(collections.Counter)
for r in rows:
    if r["route"] and r["type"] == "Invoice": main[r["cust_id"]][r["route"]] += r["amt"]
for r in rows:
    if r["route"] is None:
        c = main.get(r["cust_id"])
        if c: r["route"] = c.most_common(1)[0][0]; r["basis"] += f", so the customer's main route"
        else: r["route"] = NR; r["basis"] += ", customer has no weekday orders"
    # sales go in the week the order was placed; a credit note goes in the week it was issued
    d = r["inv_date"] if r["type"] == "Credit note" else (r["order_date"] or r["inv_date"])
    r["week"] = d - dt.timedelta(days=d.weekday())
total = round(sum(r["amt"] for r in rows), 2)
RT = {k: sum(r["amt"] for r in rows if r["route"] == k) for k in (MW, TF, NR)}
assert abs(sum(RT.values()) - total) < 0.01

# weeks: full weeks only in the average. First FY week starts on a Wednesday (1 Apr), the current week is not over.
first_full = FY0 + dt.timedelta(days=(7 - FY0.weekday()) % 7)
last_full = TODAY - dt.timedelta(days=TODAY.weekday() + 7)   # Monday of the last finished week
weeks_all = sorted({r["week"] for r in rows} | {first_full + dt.timedelta(weeks=i) for i in range(((last_full - first_full).days // 7) + 1)})
full_weeks = [w for w in weeks_all if first_full <= w <= last_full]

NAVY, BAND, GOLD = "1A3C34", "F2F6F4", "FCE9B8"
def F(size=10, bold=False, color=None): return Font(name="Arial", size=size, bold=bold, color=color)
fill = lambda c: PatternFill("solid", fgColor=c)
def hdr(ws, row, vals, height=30):
    for i, v in enumerate(vals, 1):
        c = ws.cell(row, i, v); c.font = F(10, True, "FFFFFF"); c.fill = fill(NAVY)
        c.alignment = Alignment(horizontal="left" if i == 1 else "center", vertical="center", wrap_text=True)
    ws.row_dimensions[row].height = height
def line(ws, row, vals, band=False, bold=False, money_cols=(), size=10):
    for i, v in enumerate(vals, 1):
        c = ws.cell(row, i, v); c.font = F(size, bold)
        if band: c.fill = fill(BAND)
        if i in money_cols: c.number_format = '"$"#,##0;[Red]-"$"#,##0'
def widths(ws, w):
    for i, x in enumerate(w, 1): ws.column_dimensions[get_column_letter(i)].width = x
def fmt(d): return f"{d.day} {d:%b %Y}"

WEEKNO = {w: i + 1 for i, w in enumerate(full_weeks)}
def weeklabel(w): return f"Week {WEEKNO[w]}" if w in WEEKNO else "Part week"
os.makedirs(OUT, exist_ok=True)
for rt, short, title in ((MW, "Mon-Wed", "Monday to Wednesday route"), (TF, "Thu-Fri", "Thursday to Friday route")):
    rr = [r for r in rows if r["route"] == rt]
    def wk_sum(w): return sum(r["amt"] for r in rr if r["week"] == w)
    vals = [(w, wk_sum(w)) for w in full_weeks]
    avg = sum(v for _, v in vals) / len(vals); tot = sum(r["amt"] for r in rr)
    best = max(vals, key=lambda x: x[1]); low = min(vals, key=lambda x: x[1])
    ninv = sum(1 for r in rr if r["type"] == "Invoice")
    wb = Workbook()
    # ===== Summary
    ws = wb.active; ws.title = "Summary"; ws.sheet_view.showGridLines = False; widths(ws, [34, 22])
    ws["A1"] = f"Naitik Trivedi - {title}"; ws["A1"].font = F(18, True, NAVY); ws.row_dimensions[1].height = 30
    ws["A2"] = f"This financial year, {fmt(FY0)} to {fmt(TODAY)}. Sales before GST, after credit notes."; ws["A2"].font = F(10, False, "666666")
    r = 4
    line(ws, r, ["Average sales per week", avg], bold=True, money_cols=(2,), size=14)
    for i in (1, 2): ws.cell(r, i).fill = fill(GOLD)
    ws.cell(r, 2).alignment = Alignment(horizontal="right", vertical="center"); ws.row_dimensions[r].height = 28; r += 1
    for i, (lab, v, m) in enumerate((("Total sales this financial year", tot, True),
                                     ("Best week", f"${best[1]:,.0f} (Week {WEEKNO[best[0]]})", False),
                                     ("Lowest week", f"${low[1]:,.0f} (Week {WEEKNO[low[0]]})", False),
                                     ("Customers", len({x["cust_id"] for x in rr}), False),
                                     ("Invoices", ninv, False))):
        line(ws, r, [lab, v], band=i % 2 == 0, money_cols=(2,) if m else (), size=11)
        ws.cell(r, 2).alignment = Alignment(horizontal="right"); r += 1
    # ===== Weekly
    ws = wb.create_sheet("Weekly"); widths(ws, [10, 16, 18])
    hdr(ws, 1, ["Week", "Week starting", "Sales"])
    r = 2
    for i, (w, v) in enumerate(vals):
        line(ws, r, [f"Week {i + 1}", fmt(w), v], band=i % 2 == 0, money_cols=(3,)); r += 1
    line(ws, r, ["Total", "", sum(v for _, v in vals)], bold=True, money_cols=(3,)); r += 1
    line(ws, r, ["Average", "", avg], bold=True, money_cols=(3,))
    for j in (1, 2, 3): ws.cell(r, j).fill = fill(GOLD)
    r += 2
    ws.cell(r, 1, "Part weeks, not in the average:").font = F(9, True, "666666"); r += 1
    for w in [w for w in weeks_all if w not in full_weeks]:
        lab = f"Week of {fmt(w)} (the year started on {fmt(FY0)})" if w < FY0 else f"Week of {fmt(w)} (week not finished)"
        line(ws, r, [lab, "", wk_sum(w)], money_cols=(3,), size=9); ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=2); r += 1
    ws.freeze_panes = "A2"
    # ===== Customers
    ws = wb.create_sheet("Customers"); widths(ws, [46, 18, 10, 16, 10])
    hdr(ws, 1, ["Customer", "Town", "Invoices", "Sales", "Share"])
    cu = collections.defaultdict(list)
    for x in rr: cu[x["cust_id"]].append(x)
    for i, (cid, hs) in enumerate(sorted(cu.items(), key=lambda kv: -sum(h["amt"] for h in kv[1]))):
        v = sum(h["amt"] for h in hs)
        line(ws, i + 2, [hs[0]["cust"], (P.get(cid) or {}).get("city") or "", sum(1 for h in hs if h["type"] == "Invoice"), v, v / tot if tot else 0], band=i % 2 == 0, money_cols=(4,))
        ws.cell(i + 2, 5).number_format = "0%"
    n = len(cu) + 2; line(ws, n, ["Total", "", ninv, tot, 1], bold=True, money_cols=(4,)); ws.cell(n, 5).number_format = "0%"
    ws.freeze_panes = "A2"; ws.auto_filter.ref = f"A1:E{n-1}"
    # ===== Invoices
    ws = wb.create_sheet("Invoices"); widths(ws, [12, 13, 18, 14, 44, 14, 28])
    hdr(ws, 1, ["Week", "Order date", "Invoice", "Type", "Customer", "Sales", "How it was ordered"])
    srt = sorted(rr, key=lambda x: (x["order_date"] or x["inv_date"], x["inv"]))
    for i, x in enumerate(srt):
        how = ("Website, " if x["online"] else "Rep, ") + (f"{x['order_date']:%A}" if x["order_date"] else "no order on invoice")
        if x["basis"].startswith(("Weekend", "No sales order")): how += " (customer's usual route)"
        line(ws, i + 2, [weeklabel(x["week"]), (x["order_date"] or x["inv_date"]).isoformat(), x["inv"], x["type"], x["cust"], x["amt"], how], band=i % 2 == 0, money_cols=(6,))
    n = len(srt) + 2; line(ws, n, ["Total", "", "", "", "", tot, ""], bold=True, money_cols=(6,))
    ws.freeze_panes = "A2"; ws.auto_filter.ref = f"A1:G{n-1}"
    fn = f"Naitik_{short}_Route_Average_Weekly_Sales_FY26.xlsx"
    wb.save(os.path.join(OUT, fn))
    print(f"{short}: avg ${avg:,.2f} | total ${tot:,.2f} | {len(vals)} weeks -> {fn}")
print(f"Naitik total ${total:,.2f}")
