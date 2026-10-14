"""Builds one FY Excel report per Ostendo rep code (Summary, Customers by Region,
Online Orders, Verification Notes, Invoice Lines).

Usage:
  python -I build_rep_reports.py DATA_DIR OUT_DIR [FROM=2026-04-01] [TO=today]

DATA_DIR holds hdr.json (Ostendo SALESINVOICEHEADER pull, see pull_ostendo.sh) and
shop.json (pull-shopify-orders.mjs). See README.md for the rules and traps.

All numbers are written as plain values (no formulas) on purpose: the files are read
in phone previewers that show formulas without cached results as blank.
"""
import json, re, sys, datetime as dt, collections, os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

DATA, OUT = sys.argv[1], sys.argv[2]
FROM = dt.date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 else dt.date(2026, 4, 1)
TO = dt.date.fromisoformat(sys.argv[4]) if len(sys.argv) > 4 else dt.date.today()

# Rep code -> name. No salesperson table exists in Ostendo, so this is maintained here.
REPS = {"410": "Jerry", "420": "Michelle", "430": "Keith", "450": "Christchurch Office-Online",
        "460": "Chris", "461": "Ravi Kumar", "470": "Lynette", "490": "Leith"}
# Billed-to accounts treated as Corporate EDI (not rep-keyed, not online). Extend when Kishan confirms more.
EDI_CUSTOMERS = {"foodstuffs south island ltd"}
SHOP_START = dt.date(2026, 8, 15)  # Shopify B2B go-live

NAVY, GOLD, PALE = "1A3C34", "C9A24A", "F4EBD3"
F = lambda **k: Font(name="Arial", size=k.pop("size", 10), **k)
thin = Side(style="thin", color="D0D0D0")


def pd(s): return dt.datetime.strptime(s, "%d/%m/%Y").date()
def toks(s): return set(re.findall(r"[a-z0-9]{3,}", (s or "").lower()))
def base(s): return re.sub(r"\s+(19|20)\d\d$", "", (s or "").strip())


H = [h for h in json.load(open(f"{DATA}/hdr.json", encoding="utf-8")) if FROM <= pd(h["INVOICEDATE"]) <= TO]
O = [o for o in json.load(open(f"{DATA}/shop.json", encoding="utf-8")) if not o["cancelledAt"]]
for h in H:
    h["_d"] = pd(h["INVOICEDATE"]); h["_rep"] = h["SALESPERSON"].split("-")[0]
    h["_store"] = base(h["DELIVERYCUSTOMER"] or h["CUSTOMER"])

# ---- Online flag 1: Shopify order matched to an invoice (1-to-1, any rep) -----------------
cands = []
for oi, o in enumerate(O):
    amt = float(o["currentSubtotalPriceSet"]["shopMoney"]["amount"])
    od = dt.datetime.fromisoformat(o["createdAt"].replace("Z", "+00:00")).astimezone(dt.timezone(dt.timedelta(hours=13))).date()
    o["_d"] = od; o["_amt"] = amt
    cn = toks(((o["purchasingEntity"] or {}).get("company") or {}).get("name")) | toks(((o["purchasingEntity"] or {}).get("location") or {}).get("name"))
    for hi, h in enumerate(H):
        if h["INVOICEORCREDIT"] != "Invoice" or h["_d"] < SHOP_START: continue
        dd = (h["_d"] - od).days
        if not -1 <= dd <= 14: continue
        diff = abs(h["INVOICENETTAMOUNT"] - amt) / max(amt, 1)
        if diff > 0.12: continue
        ov = len(cn & (toks(h["DELIVERYCUSTOMER"]) | toks(h["CUSTOMER"])))
        if ov < 1: continue
        cands.append((-ov, diff, abs(dd), oi, hi))
cands.sort()
usedO, usedH, match = set(), set(), {}
for _, diff, _, oi, hi in cands:
    if oi in usedO or hi in usedH: continue
    usedO.add(oi); usedH.add(hi); match[hi] = oi
for hi, h in enumerate(H):
    h["_shop"] = O[match[hi]]["name"] if hi in match else ""

# ---- Online flag 2: duplicate-redo rule (Pratham, 14 Oct 2026) ---------------------------
# Same store + same day + same amount on 2+ invoices = the rep re-keyed an online order.
grp = collections.defaultdict(list)
for h in H:
    if h["INVOICEORCREDIT"] == "Invoice": grp[(h["_store"].lower(), h["_d"], round(h["INVOICENETTAMOUNT"], 2))].append(h)
for g in grp.values():
    if len(g) > 1:
        for h in g: h["_dup"] = True

def channel(h):
    if h["INVOICEORCREDIT"] != "Invoice": return "Credit"
    if h["CUSTOMER"].strip().lower() in EDI_CUSTOMERS: return "Corporate EDI"
    if h["_shop"] or h.get("_dup"): return "Online"
    return "Rep / Phone"
for h in H: h["_ch"] = channel(h)

# ---- Styling helpers ----------------------------------------------------------------------
def head(ws, row, vals):
    for i, v in enumerate(vals, 1):
        c = ws.cell(row, i, v); c.font = F(bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor=NAVY)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
def title(ws, text, sub):
    ws["A1"] = text; ws["A1"].font = F(size=16, bold=True, color=NAVY)
    ws["A2"] = sub; ws["A2"].font = F(size=9, italic=True, color="666666")
def widths(ws, w):
    for i, x in enumerate(w, 1): ws.column_dimensions[get_column_letter(i)].width = x
def money(c): c.number_format = '"$"#,##0.00;[Red]-"$"#,##0.00'
def body(ws, r0, r1, ncol):
    for r in range(r0, r1 + 1):
        for c in range(1, ncol + 1):
            x = ws.cell(r, c); x.font = F(); x.border = Border(bottom=thin)
            x.alignment = Alignment(vertical="center", wrap_text=(c == 1 and ncol < 8))
def totalrow(ws, r, ncol):
    for c in range(1, ncol + 1):
        x = ws.cell(r, c); x.font = F(bold=True); x.fill = PatternFill("solid", fgColor=PALE)

CITY_FIX = {"Chirschurch": "Christchurch", "Chch": "Christchurch"}  # typos seen in Ostendo billing cities
def region_of(h):
    c = (h["BILLINGCITY"] or "Unknown").strip().title() or "Unknown"
    return CITY_FIX.get(c, c)

os.makedirs(OUT, exist_ok=True)
stamp = TO.strftime("%d%b%Y")
written = []
for code, name in REPS.items():
    rows = sorted([h for h in H if h["_rep"] == code], key=lambda h: (h["_d"], h["INVOICENUMBER"]))
    if not rows: continue
    inv = [h for h in rows if h["INVOICEORCREDIT"] == "Invoice"]; cr = [h for h in rows if h["INVOICEORCREDIT"] != "Invoice"]
    gross = sum(h["INVOICENETTAMOUNT"] for h in inv); credits = sum(h["INVOICENETTAMOUNT"] for h in cr)
    wb = Workbook()
    # ---------------- Summary
    ws = wb.active; ws.title = "Summary"
    title(ws, f"{name} (rep code {code}): FY26 sales by channel",
          f"Ostendo invoices {FROM:%d %b %Y} to {TO:%d %b %Y}, ex GST. Codes with a -1 suffix are folded into {code}. Requested by Kishan.")
    head(ws, 4, ["Channel", "Invoices", "Revenue (ex GST)", "% of revenue"])
    r = 5
    for ch in ("Online", "Rep / Phone", "Corporate EDI"):
        s = [h for h in inv if h["_ch"] == ch]; v = sum(h["INVOICENETTAMOUNT"] for h in s)
        ws.append([ch, len(s), v, (v / gross) if gross else 0]); r += 1
    ws.append(["Total invoiced", len(inv), gross, 1 if gross else 0]); totalrow(ws, r, 4)
    body(ws, 5, r - 1, 4)
    for rr in range(5, r + 1): money(ws.cell(rr, 3)); ws.cell(rr, 4).number_format = "0.0%"
    r += 2
    for lab, val in (("Credit notes", len(cr)), ("Credits value", credits), ("Net revenue after credits", gross + credits),
                     ("Distinct delivery stores", len({h["_store"].lower() for h in inv}))):
        ws.cell(r, 1, lab).font = F(bold=True); c = ws.cell(r, 2, val); c.font = F()
        if "value" in lab or "Net" in lab: money(c)
        r += 1
    r += 1; head(ws, r, ["Month", "Invoices", "Revenue (ex GST)", "Online share"]); r += 1; m0 = r
    mo = collections.OrderedDict()
    for h in inv: mo.setdefault(h["_d"].strftime("%Y-%m"), []).append(h)
    for k, s in sorted(mo.items()):
        v = sum(h["INVOICENETTAMOUNT"] for h in s); on = sum(h["INVOICENETTAMOUNT"] for h in s if h["_ch"] == "Online")
        ws.cell(r, 1, dt.datetime.strptime(k, "%Y-%m").strftime("%b %Y")); ws.cell(r, 2, len(s)); ws.cell(r, 3, v); ws.cell(r, 4, on / v if v else 0); r += 1
    body(ws, m0, r - 1, 4)
    for rr in range(m0, r): money(ws.cell(rr, 3)); ws.cell(rr, 4).number_format = "0.0%"
    widths(ws, [32, 14, 20, 16]); ws.freeze_panes = "A5"
    # ---------------- Customers by Region
    ws = wb.create_sheet("Customers by Region")
    title(ws, "Customers by region", "Delivery store (year suffixes merged), region = billing city on the invoice. Chain-billed stores show the head-office city.")
    head(ws, 4, ["Region", "Delivery store", "Billed to", "Invoices", "Revenue (ex GST)", "Online", "Rep / Phone", "Corporate EDI", "Last invoice"])
    cust = collections.defaultdict(lambda: {"n": 0, "v": 0.0, "ch": collections.Counter(), "last": None, "bill": set(), "reg": collections.Counter()})
    for h in inv:
        c = cust[h["_store"]]; c["n"] += 1; c["v"] += h["INVOICENETTAMOUNT"]; c["ch"][h["_ch"]] += h["INVOICENETTAMOUNT"]
        c["last"] = max(c["last"] or h["_d"], h["_d"]); c["bill"].add(h["CUSTOMER"]); c["reg"][region_of(h)] += 1
    items = sorted(cust.items(), key=lambda kv: (kv[1]["reg"].most_common(1)[0][0], -kv[1]["v"]))
    r = 5
    for st, c in items:
        ws.append([c["reg"].most_common(1)[0][0], st, "; ".join(sorted(c["bill"]))[:80], c["n"], c["v"], c["ch"]["Online"], c["ch"]["Rep / Phone"], c["ch"]["Corporate EDI"], c["last"]]); r += 1
    ws.append(["Total", "", "", len(inv), gross, sum(c["ch"]["Online"] for c in cust.values()), sum(c["ch"]["Rep / Phone"] for c in cust.values()), sum(c["ch"]["Corporate EDI"] for c in cust.values()), ""])
    body(ws, 5, r - 1, 9); totalrow(ws, r, 9)
    for rr in range(5, r + 1):
        for cc in (5, 6, 7, 8): money(ws.cell(rr, cc))
        ws.cell(rr, 9).number_format = "dd mmm yyyy"
    widths(ws, [18, 38, 34, 10, 18, 16, 16, 16, 14]); ws.freeze_panes = "A5"; ws.auto_filter.ref = f"A4:I{r-1}"
    # ---------------- Online Orders
    ws = wb.create_sheet("Online Orders")
    title(ws, "Online orders (Shopify match plus duplicate-redo rule)", "Match = same store, amount within 12 percent, invoiced within -1 to +14 days of the Shopify order. Duplicate = same store, day and amount twice.")
    head(ws, 4, ["Invoice date", "Invoice", "Delivery store", "Amount (ex GST)", "Evidence", "Shopify order"])
    on = [h for h in inv if h["_ch"] == "Online"]; r = 5
    for h in on:
        ws.append([h["_d"], h["INVOICENUMBER"], h["_store"], h["INVOICENETTAMOUNT"], "Shopify order matched" if h["_shop"] else "Duplicate same-day same-amount", h["_shop"]]); r += 1
    ws.append(["Total", "", "", sum(h["INVOICENETTAMOUNT"] for h in on), f"{len(on)} invoices", ""])
    body(ws, 5, r - 1, 6); totalrow(ws, r, 6)
    for rr in range(5, r + 1): money(ws.cell(rr, 4)); ws.cell(rr, 1).number_format = "dd mmm yyyy"
    widths(ws, [14, 14, 40, 18, 34, 14]); ws.freeze_panes = "A5"
    # ---------------- Invoice Lines
    ws = wb.create_sheet("Invoice Lines")
    title(ws, "Every FY26 invoice and credit", "Source: Ostendo SALESINVOICEHEADER, INVOICEREVERSED = 0.")
    head(ws, 4, ["Date", "Invoice", "Type", "Billed to", "Delivery store", "Billing city", "Amount (ex GST)", "Channel", "Ostendo order", "Shopify order"])
    for h in rows: ws.append([h["_d"], h["INVOICENUMBER"], h["INVOICEORCREDIT"], h["CUSTOMER"], h["DELIVERYCUSTOMER"], h["BILLINGCITY"], h["INVOICENETTAMOUNT"], h["_ch"], h["GROUPORDERNUMBERS"], h["_shop"]])
    body(ws, 5, 4 + len(rows), 10)
    for rr in range(5, 5 + len(rows)): money(ws.cell(rr, 7)); ws.cell(rr, 1).number_format = "dd mmm yyyy"
    widths(ws, [13, 13, 9, 32, 36, 16, 16, 15, 16, 12]); ws.freeze_panes = "A5"; ws.auto_filter.ref = f"A4:J{4+len(rows)}"
    # ---------------- Verification Notes
    ws = wb.create_sheet("Verification Notes")
    title(ws, "How this report was built and what it cannot prove", f"Generated {dt.date.today():%d %b %Y}")
    shop_n = sum(1 for h in inv if h["_shop"]); dup_n = sum(1 for h in inv if h.get("_dup") and not h["_shop"])
    notes = [
        ("Source", "Ostendo reporting API, SALESINVOICEHEADER. Invoice net amount is ex GST. Reversed invoices excluded."),
        ("Rep code", f"SALESPERSON = {code} (including {code}-1 style suffixes). The name comes from Pratham, not from Ostendo."),
        ("Totals", f"Invoiced {len(inv)} invoices = ${gross:,.2f}. Credits {len(cr)} = ${credits:,.2f}. Net ${gross+credits:,.2f}."),
        ("Online (Shopify)", f"{shop_n} invoices matched to a Shopify B2B order (live since 15 Aug 2026), matched on store name, amount and date. Fuzzy: roughly 93 percent of all Shopify orders find an invoice, so a few online orders may sit under Rep / Phone."),
        ("Online (redo rule)", f"{dup_n} invoices counted Online because the same store had the same amount on the same day twice (rep re-keyed an online order). Revenue is as invoiced in Ostendo, never double counted by this report."),
        ("Old website orders", "Orders from the old dr-admin site are NOT in this online figure: Ostendo does not mark them and the old site deletion log is not accessible (403). Online is therefore a floor."),
        ("Created By", "The Ostendo Created By field (XQS = online) exists only on the manual Order Screen export, never through the API. SYSUSERCREATED on invoices is the invoicing user, not the order source."),
        ("Corporate EDI", "Billed-to " + ", ".join(sorted(EDI_CUSTOMERS)) + " only. Add other chains in build_rep_reports.py once Kishan confirms them."),
        ("Region", "Billing city from the invoice. Ostendo exposes no delivery address, so chain-billed stores show the head-office city."),
        ("Chain accounts", "Several customers are billed under two rep codes at once (chain stores split between reps). That is not a reassignment."),
    ]
    head(ws, 4, ["Topic", "Note"])
    for t, n in notes: ws.append([t, n])
    body(ws, 5, 4 + len(notes), 2)
    for rr in range(5, 5 + len(notes)): ws.cell(rr, 2).alignment = Alignment(wrap_text=True, vertical="top"); ws.cell(rr, 1).font = F(bold=True)
    widths(ws, [22, 110])
    fn = f"{name.replace(' ', '_')}_{code}_FY26_Location_Channel_Report.xlsx"
    wb.save(os.path.join(OUT, fn)); written.append((code, name, len(inv), gross, credits, shop_n, dup_n, fn))

summ = [f"{c} {n}: {i} inv, ${g:,.2f}, credits ${cr:,.2f}, shopify-match {s}, dup {d} -> {fn}" for c, n, i, g, cr, s, d, fn in written]
print("\n".join(summ))
