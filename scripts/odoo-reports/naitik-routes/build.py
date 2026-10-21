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
for m in D["moves"]:
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
    d = r["order_date"] or r["inv_date"]
    r["week"] = d - dt.timedelta(days=d.weekday())
total = round(sum(r["amt"] for r in rows), 2)
RT = {k: sum(r["amt"] for r in rows if r["route"] == k) for k in (MW, TF, NR)}
assert abs(sum(RT.values()) - total) < 0.01

# weeks: full weeks only in the average. First FY week starts on a Wednesday (1 Apr), the current week is not over.
first_full = FY0 + dt.timedelta(days=(7 - FY0.weekday()) % 7)
last_full = TODAY - dt.timedelta(days=TODAY.weekday() + 7)   # Monday of the last finished week
weeks_all = sorted({r["week"] for r in rows} | {first_full + dt.timedelta(weeks=i) for i in range(((last_full - first_full).days // 7) + 1)})
full_weeks = [w for w in weeks_all if first_full <= w <= last_full]

NAVY, BAND = "1A3C34", "F2F6F4"
def F(size=9, bold=False, color=None): return Font(name="Arial", size=size, bold=bold, color=color)
def hdr(ws, row, vals):
    for i, v in enumerate(vals, 1):
        c = ws.cell(row, i, v); c.font = F(10, True, "FFFFFF"); c.fill = PatternFill("solid", fgColor=NAVY); c.alignment = Alignment(wrap_text=True, vertical="center")
def line(ws, row, vals, band=False, bold=False):
    for i, v in enumerate(vals, 1):
        c = ws.cell(row, i, v); c.font = F(9, bold)
        if band: c.fill = PatternFill("solid", fgColor=BAND)
def money(c): c.number_format = '"$"#,##0.00;[Red]-"$"#,##0.00'
def widths(ws, w):
    for i, x in enumerate(w, 1): ws.column_dimensions[get_column_letter(i)].width = x
def fmt(d): return f"{d.day} {d:%b %Y}"

os.makedirs(OUT, exist_ok=True)
results = {}
for route, short in ((MW, "Mon-Wed"), (TF, "Thu-Fri")):
    rr = [r for r in rows if r["route"] == route]
    wk = collections.defaultdict(list)
    for r in rr: wk[r["week"]].append(r)
    full_total = sum(sum(r["amt"] for r in wk.get(w, [])) for w in full_weeks)
    avg = full_total / len(full_weeks)
    inv = [r for r in rr if r["type"] == "Invoice"]; cr = [r for r in rr if r["type"] != "Invoice"]
    wk_vals = [(w, sum(r["amt"] for r in wk.get(w, []))) for w in full_weeks]
    best = max(wk_vals, key=lambda x: x[1]); low = min(wk_vals, key=lambda x: x[1])
    results[route] = (avg, full_total, sum(r["amt"] for r in rr))
    wb = Workbook()
    ws = wb.active; ws.title = "Summary"; widths(ws, [44, 18, 4, 4])
    ws["A1"] = f"Worthy Products - Naitik Trivedi, {route} route"; ws["A1"].font = F(16, True, NAVY)
    ws["A2"] = "Average sales per week, this financial year"; ws["A2"].font = F(10, False, "666666")
    ws["A3"] = f"{fmt(FY0)} to {fmt(TODAY)} - Odoo invoices less credit notes, product lines only, before GST"; ws["A3"].font = F(9, False, "888888")
    r = 5
    for lab, val, kind in (("Average sales per week", avg, "$"),
                           (f"Weeks in the average (full weeks {fmt(full_weeks[0])} to {fmt(full_weeks[-1] + dt.timedelta(days=6))})", len(full_weeks), "n"),
                           ("Sales in those weeks", full_total, "$"),
                           ("Best week", best[1], "$"), ("  week starting", fmt(best[0]), "t"),
                           ("Lowest week", low[1], "$"), ("  week starting", fmt(low[0]), "t"),
                           ("All sales on this route this financial year", sum(r["amt"] for r in rr), "$"),
                           ("Invoices / credit notes", f"{len(inv)} / {len(cr)}", "t"),
                           ("Customers", len({r["cust_id"] for r in rr}), "n")):
        ws.cell(r, 1, lab).font = F(10, lab == "Average sales per week", "666666" if lab != "Average sales per week" else NAVY)
        c = ws.cell(r, 2, val); c.font = F(12 if lab == "Average sales per week" else 10, True)
        if kind == "$": money(c)
        r += 1
    r += 1; ws.cell(r, 1, "How the route is decided").font = F(10, True, NAVY); r += 1
    note = ("An order belongs to the Monday to Wednesday route if it was placed on a Monday, Tuesday or Wednesday, and to the Thursday to Friday route if it was placed on a Thursday or Friday "
            "(the order date in Odoo, NZ time). Website orders follow the day they were placed in the same way. Weekend orders and invoices with no sales order go to the customer's main route: "
            "the route where most of that customer's weekday sales were. A credit note follows the order it credits. Weeks run Monday to Sunday by order date. The average uses full weeks only: the week of 1 April (the year started on a Wednesday) "
            "and the current week are left out, but their sales are shown on the Weekly sheet.")
    ws.merge_cells(start_row=r, start_column=1, end_row=r + 6, end_column=4)
    c = ws.cell(r, 1, note); c.font = F(8.5, False, "888888"); c.alignment = Alignment(wrap_text=True, vertical="top")

    ws = wb.create_sheet("Weekly"); widths(ws, [16, 12, 12, 16, 22])
    hdr(ws, 1, ["Week starting", "Invoices", "Credit notes", "Sales", "In the average?"])
    rr_ = 2
    for i, w in enumerate(weeks_all):
        hs = wk.get(w, [])
        line(ws, rr_, [w.isoformat(), sum(1 for h in hs if h["type"] == "Invoice"), sum(1 for h in hs if h["type"] != "Invoice"), sum(h["amt"] for h in hs),
                       "Yes" if w in full_weeks else ("No, part week (FY started 1 Apr)" if w < first_full else "No, week not finished")], band=i % 2 == 0)
        money(ws.cell(rr_, 4)); rr_ += 1
    line(ws, rr_, ["Total", len(inv), len(cr), sum(r["amt"] for r in rr), ""], bold=True); money(ws.cell(rr_, 4)); rr_ += 1
    line(ws, rr_, ["Average, full weeks", "", "", avg, f"{len(full_weeks)} weeks"], bold=True); money(ws.cell(rr_, 4))
    ws.freeze_panes = "A2"

    ws = wb.create_sheet("Customers"); widths(ws, [44, 18, 10, 16, 12, 14])
    hdr(ws, 1, ["Customer", "City", "Invoices", "Sales", "Share", "Last order"])
    cu = collections.defaultdict(list)
    for r in rr: cu[r["cust_id"]].append(r)
    tot = sum(r["amt"] for r in rr)
    for i, (cid, hs) in enumerate(sorted(cu.items(), key=lambda kv: -sum(h["amt"] for h in kv[1]))):
        v = sum(h["amt"] for h in hs)
        line(ws, i + 2, [hs[0]["cust"], (P.get(cid) or {}).get("city") or "", sum(1 for h in hs if h["type"] == "Invoice"), v, v / tot if tot else 0, max((h["order_date"] or h["inv_date"]) for h in hs).isoformat()], band=i % 2 == 0)
        money(ws.cell(i + 2, 4)); ws.cell(i + 2, 5).number_format = "0.0%"
    n = len(cu) + 2; line(ws, n, ["Total", "", len(inv), tot, 1, ""], bold=True); money(ws.cell(n, 4)); ws.cell(n, 5).number_format = "0%"
    ws.freeze_panes = "A2"; ws.auto_filter.ref = f"A1:F{n-1}"

    ws = wb.create_sheet("Invoices"); widths(ws, [14, 14, 18, 12, 44, 14, 16, 46])
    hdr(ws, 1, ["Order date", "Invoice date", "Invoice", "Type", "Customer", "Sales", "Week starting", "Why on this route"])
    for i, r in enumerate(sorted(rr, key=lambda r: (r["order_date"] or r["inv_date"], r["inv"]))):
        line(ws, i + 2, [r["order_date"].isoformat() if r["order_date"] else "", r["inv_date"].isoformat(), r["inv"], r["type"], r["cust"], r["amt"], r["week"].isoformat(), r["basis"]], band=i % 2 == 0)
        money(ws.cell(i + 2, 6))
    n = len(rr) + 2; line(ws, n, ["Total", "", "", "", "", tot, "", ""], bold=True); money(ws.cell(n, 6))
    ws.freeze_panes = "A2"; ws.auto_filter.ref = f"A1:H{n-1}"

    ws = wb.create_sheet("Verification Notes"); widths(ws, [32, 44, 46, 40])
    ws.merge_cells("A1:D1"); ws["A1"] = "Verification: how these numbers were checked"; ws["A1"].font = F(14, True, NAVY)
    hdr(ws, 3, ["Check", "Method", "Result", "Conclusion"])
    other = [r for r in rows if r["route"] != route]
    by_basis = collections.Counter(r["basis"].split(",")[0] for r in rr)
    checks = [
        ("Do both routes add up to Naitik's total?", "Added Mon-Wed, Thu-Fri and anything not on a route, and compared with all of Naitik's invoices less credit notes for the year.",
         f"Mon-Wed ${RT[MW]:,.2f} + Thu-Fri ${RT[TF]:,.2f} + not on a route ${RT[NR]:,.2f} = ${total:,.2f}.",
         "Every dollar is counted once, on one route."),
        ("Why is the route not taken from the customer's tag?", "Checked the route tags on Naitik's customers in Odoo.",
         "Both trips carry the same 'Up North' tag, so the tag cannot tell them apart.", "The order day is used instead."),
        ("How were the invoices on this route placed?", "Counted the reason each invoice sits on this route.",
         "; ".join(f"{k}: {v}" for k, v in by_basis.most_common()), "Most follow the day the order was taken."),
        ("Is anything left out?", "Listed every Naitik invoice or credit note that is on neither route.",
         ("; ".join(f"{r['inv']} ({r['type'].lower()}, Odoo untaxed {next(m['amount_untaxed_signed'] for m in D['moves'] if m['name'] == r['inv'])}, product sales {r['amt']:.2f})" for r in rows if r['route'] == NR) or "None"),
         "Lines with no product on them are not sales on the finance basis, so they add nothing to either route."),
        ("Is the weekly average fair?", "Average uses full Monday-Sunday weeks only.",
         f"{len(full_weeks)} full weeks. The part week of 1 April and the current week are shown but not averaged.", "No part week drags the average down."),
    ]
    for i, ck in enumerate(checks):
        for j, v in enumerate(ck, 1):
            c = ws.cell(4 + i, j, v); c.font = F(10, False, "000000"); c.alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[4 + i].height = 15 * max(2, max(-(-len(str(v)) // 44) for v in ck))
    fn = f"Naitik_{short}_Route_Average_Weekly_Sales_FY26.xlsx"
    wb.save(os.path.join(OUT, fn))
    print(f"{route}: avg/week ${avg:,.2f} over {len(full_weeks)} weeks; route total ${sum(r['amt'] for r in rr):,.2f}; -> {fn}")
print("Naitik total", f"{total:,.2f}", "| not on a route", f"{sum(r['amt'] for r in rows if r['route'] == NR):,.2f}", "| basis counts", collections.Counter(r['basis'].split(',')[0] for r in rows))
