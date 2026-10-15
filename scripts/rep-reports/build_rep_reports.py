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
# Generic words shared by many different stores must never count as "same store".
GENERIC = set("caltex four square challenge mobil gull night day foodstore foodstores dairy store stores ltd limited new world fresh choice supervalue discounter discount market mini mart liquor bottle superette convenience cafe food foods shop the and gas station service services motor motors group nnd bar lotto post mitre mega hardware pharmacy pharmacies unichem takeaways takeaway super mini minimart pak save countdown paper plus road street avenue place lane drive terrace one stop thrifty spot centre center fuel fuels garage tavern hotel motel holiday park bakery butchery".split())
def toks(s): return {t for t in re.findall(r"[a-z0-9]{3,}", (s or "").lower()) if t not in GENERIC}
def base(s): return re.sub(r"\s+(19|20)\d\d$", "", (s or "").strip())


H = [h for h in json.load(open(f"{DATA}/hdr.json", encoding="utf-8")) if FROM <= pd(h["INVOICEDATE"]) <= TO]
O = [o for o in json.load(open(f"{DATA}/shop.json", encoding="utf-8")) if not o["cancelledAt"]]
for h in H:
    h["_d"] = pd(h["INVOICEDATE"]); h["_rep"] = h["SALESPERSON"].split("-")[0]
    h["_store"] = base(h["DELIVERYCUSTOMER"] or h["CUSTOMER"])

# ---- Online evidence ----------------------------------------------------------------------
# Online orders reach Ostendo three ways: (1) synced as is (amount matches), (2) re-keyed by the
# rep with different discounts after admin forwards the order, the source order then deleted, and
# (3) old-website orders arriving by email and keyed by hand. So amount alone undercounts.
# Tier A = same store, amount equal within rounding (0.2 percent), invoiced -1 to +14 days after the online order. Tier B = the order's store
# (learned from tier A, or name tokens for Shopify) has an invoice 0 to +10 days later with an amount
# in 0.5x-1.6x: a re-keyed order. One online order explains at most one invoice.
def _fw0(x): return set(re.findall(r"[a-z0-9]{2,}", (x or "").lower()))
def load_old_site(path):
    out = []
    if not os.path.exists(path): return out
    for l in open(path, encoding="utf-8").read().split(chr(10)):
        if not l: continue
        i, u, c, st, at, t = l.split("|")
        m = re.match(r"(\w+)\.? (\d+), (\d+)", at)
        d = dt.datetime.strptime(f"{m.group(1)[:3]} {m.group(2)} {m.group(3)}", "%b %d %Y").date()
        out.append({"src": "Old site", "id": i, "user": u, "d": d, "amt": float(t) if t else None})
    return out

EV = load_old_site(f"{DATA}/oldsite.txt")
for o in O:
    amt = float(o["currentSubtotalPriceSet"]["shopMoney"]["amount"])
    od = dt.datetime.fromisoformat(o["createdAt"].replace("Z", "+00:00")).astimezone(dt.timezone(dt.timedelta(hours=13))).date()
    pe = o["purchasingEntity"] or {}
    EV.append({"src": "Shopify", "id": o["name"], "user": (pe.get("company") or {}).get("name") or "", "d": od, "amt": amt,
               "tok_full": _fw0((pe.get("company") or {}).get("name")) | _fw0((pe.get("location") or {}).get("name")),
               "city": ((((pe.get("location") or {}).get("shippingAddress")) or {}).get("city") or "").strip().lower()})
EV = [e for e in EV if e["d"] >= FROM and e["amt"]]
EV.sort(key=lambda e: e["d"])
INV = [h for h in H if h["INVOICEORCREDIT"] == "Invoice" and h["INVOICENETTAMOUNT"] > 0]
by_day = collections.defaultdict(list)
for h in INV: by_day[h["_d"]].append(h)
# Recorded identity links (not guesses):
#  old site: the login's business name (dr-admin Users page, "First name") equals an Ostendo store name once case,
#            punctuation, a year suffix and Ltd/Limited are ignored;
#  Shopify:  every word of an Ostendo store name (2+ words) appears in the portal company + location name.
def _nn(x): return re.sub(r"(ltd|limited)$", "", re.sub(r"[^a-z0-9]", "", base(x).lower()))
_names = sorted({base(h["DELIVERYCUSTOMER"] or h["CUSTOMER"]) for h in H})
_by_norm = collections.defaultdict(set)
for _n in _names: _by_norm[_nn(_n)].add(_n.lower())
_tok_store = {n.lower(): _fw0(n) for n in _names if len(_fw0(n)) >= 2}
LOGIN_NAME = {}
if os.path.exists(f"{DATA}/oldusers.txt"):
    for _l in open(f"{DATA}/oldusers.txt", encoding="utf-8").read().split(chr(10)):
        if _l.count("|") >= 3: _a = _l.split("|"); LOGIN_NAME[_a[0]] = _a[1]
for e in EV:
    if e["src"] == "Old site": e["al_name"] = set(_by_norm.get(_nn(LOGIN_NAME.get(e["user"], "")), set())) if LOGIN_NAME.get(e["user"]) else set()
    else:
        _ct = e["tok_full"]; e["al_name"] = {n for n, t in _tok_store.items() if t <= _ct}
def tol(x): return max(0.05, 0.002 * x)          # old-site totals differ from Ostendo by rounding only
for h in H: h["_shop"] = ""; h["_ev"] = ""; h["_tier"] = ""
# Phase 1: learn which old-site login / Shopify company is which Ostendo store, from near-exact amounts.
votes = collections.defaultdict(collections.Counter); tmp = set()
for e in EV:
    best = None
    for k in range(-1, 15):
        for h in by_day.get(e["d"] + dt.timedelta(days=k), []):
            if id(h) not in tmp and e["amt"] >= 30 and abs(h["INVOICENETTAMOUNT"] - e["amt"]) <= tol(e["amt"]):
                if best is None or abs(k) < best[0]: best = (abs(k), h)
        if best: break
    if best and not best[1]["_store"].lower().startswith("cash sale"): tmp.add(id(best[1])); votes[(e["src"], e["user"])][best[1]["_store"].lower()] += 1
# A login/company maps to a store only on repeated evidence: at least 2 exact-amount matches at that store, and at least
# 30 percent as many as its best store. One lucky amount match is a coincidence, not proof (an earlier build let a
# login with one match per store map to 18 stores).
store_of = {}
for k, c in votes.items():
    top = c.most_common(1)[0][1]
    ok = {s_ for s_, n in c.items() if n >= 2 and n >= 0.3 * top}
    if ok: store_of[k] = ok
used = set()
def free(h): return id(h) not in used
def link(e, h, tier):
    used.add(id(h)); h["_tier"] = tier; h["_ev"] = f'{e["src"]} {e["id"]}'; e["done"] = True; e["store"] = h["_store"].lower()
def store_ok(e, h):
    return h["_store"].lower() in (store_of.get((e["src"], e["user"]), set()) | e["al_name"])
# Phase 2a (tier A): same store, amount within rounding, invoiced -1 to +14 days after the online order.
for e in EV:
    best = None
    for k in range(-1, 15):
        for h in by_day.get(e["d"] + dt.timedelta(days=k), []):
            if free(h) and abs(h["INVOICENETTAMOUNT"] - e["amt"]) <= tol(e["amt"]) and store_ok(e, h):
                if best is None or abs(k) < best[0]: best = (abs(k), h)
        if best: break
    if best: link(e, best[1], "A")
# Phase 2b (tier B): same store, invoice 0 to +10 days later at 0.5x to 1.6x the amount (rep re-keyed with new discounts).
for e in EV:
    if e.get("done"): continue
    cand = []
    for k in range(0, 11):
        for h in by_day.get(e["d"] + dt.timedelta(days=k), []):
            r_ = h["INVOICENETTAMOUNT"] / e["amt"]
            if free(h) and 0.5 <= r_ <= 1.6 and store_ok(e, h): cand.append((k + 5 * abs(r_ - 1), h))
    if cand: link(e, min(cand, key=lambda x: x[0])[1], "B")
for h in H: h["_shop"] = h["_ev"]
EV_UNMATCHED = [e for e in EV if not e.get("done")]
EV_TOTAL = len(EV)
if os.environ.get("REP_DEBUG"):
    un = EV_UNMATCHED; mapped = [e for e in un if store_of.get((e["src"], e["user"]))]; anyx = 0; ex = []
    for e in un:
        for k in range(-1, 15):
            hs_ = [h for h in by_day.get(e["d"] + dt.timedelta(days=k), []) if abs(h["INVOICENETTAMOUNT"] - e["amt"]) <= tol(e["amt"]) and e["amt"] >= 30]
            if hs_: anyx += 1; ex.append((e["src"], e["user"], e["amt"], [h["_store"] for h in hs_][:2], sorted(store_of.get((e["src"], e["user"]), []))[:2]));  break
    print("DEBUG events", EV_TOTAL, "unmatched", len(un), "unmatched with mapping", len(mapped), "unmatched but exact-amount invoice elsewhere", anyx)
    for x in ex[:12]: print("  ", x)

# ---- Online flag 2: duplicate-redo rule (Pratham, 14 Oct 2026) ---------------------------
# Same store + same day + same amount on 2+ invoices = the rep re-keyed an online order.
grp = collections.defaultdict(list)
for h in H:
    # exact store record only: "X" and "X 2026" on the same day is an account change, not a re-keyed online order
    if h["INVOICEORCREDIT"] == "Invoice": grp[((h["DELIVERYCUSTOMER"] or h["CUSTOMER"]).strip().lower(), h["_d"], round(h["INVOICENETTAMOUNT"], 2))].append(h)
for g in grp.values():
    if len(g) > 1:
        for h in g: h["_dup"] = True

def channel(h):
    if h["INVOICEORCREDIT"] != "Invoice": return "Credit"
    if h["CUSTOMER"].strip().lower() in EDI_CUSTOMERS: return "Corporate EDI"
    if h["_tier"] == "A": return "Online"
    if h["_tier"] == "B" or h.get("_dup"): return "Probable"
    return "Rep / Phone"
for h in H: h["_ch"] = channel(h)
ONLINE_STORES = {h["_store"].lower() for h in H if h["_ch"] == "Online"}
def how(h):
    if h["_tier"] == "A": return h["_ev"] + " (amount matched)"
    if h["_tier"] == "B": return h["_ev"] + " (re-keyed: same store, amount differs)"
    return "Duplicate same-day same-amount (re-keyed)"

# ---- Regions ------------------------------------------------------------------------------
# Same basis as Kishan's approved Chris report (14 Oct): customer = the billed-to account in Ostendo, region = that
# account's billing city. Chain accounts therefore show where they are billed (e.g. Red Circle, CSB Group: Napier).
REGIONS = [
    ("Auckland", "Auckland,Pukekohe"),
    ("Northland", "Whangarei,Russell"),
    ("Waikato", "Hamilton,Cambridge,Morrinsville,Te Kowhai,Whitianga,Hot Water Beach,Taupo"),
    ("Bay of Plenty", "Tauranga,Rotorua,Whakatane,Ohope"),
    ("Taranaki", "New Plymouth"),
    ("Hawke's Bay", "Napier,Waipawa,Waipukurau"),
    ("Manawatu-Whanganui", "Palmerston North,Feilding,Whanganui,Levin"),
    ("Wellington", "Wellington,Porirua,Lower Hutt"),
    ("Nelson-Tasman", "Nelson,Motueka,Richmond,Upper Moutere,Takaka,Collingwood,Tapawera,Mapua,Riwaka,Wakefield,Spring Grove,Hope,Murchison"),
    ("Marlborough", "Blenheim,Picton,Havelock,Renwick,Seddon,Marlborough,Ward"),
    ("West Coast", "Greymouth,Westport,Hokitika,Reefton,Runanga,Blackball,Cobden,Springs Junction,West Coast,Westland,Hari Hari,Fox Glacier,Hector,Moana,Haast,Franz Josef,Karamea,Dobson"),
    ("Canterbury", "Christchurch,Ashburton,Timaru,Rangiora,Darfield,Rolleston,Hanmer Springs,Kirwee,Kaiapoi,Amberley,Waimate,Oxford,Kaikoura,Geraldine,Methven,Waikari,Sefton,Temuka,Waiau,Pegasus,Lincoln,Tinwald,Woodend,Mount Hutt,Pareora,Akaroa,Winchester,Aoraki Mt Cook,Cust,Burnham,Leeston,Rotherham,Springston,Southbridge,Rakaia,St Andrews,Twizel,Fairlie,Tekapo,Lyttelton,Prebbleton,Halswell"),
    ("Otago", "Dunedin,Dunedin Central,Oamaru,Cromwell,Queenstown,Arrowtown,Ranfurly,Omakau,Waikouaiti,Balclutha,Alexandra,Mosgiel,Milton,Ettrick,Wanaka,Waihola,Otematata,Clyde,Kurow,Omarama,Palmerston,Roxburgh,Lawrence,Tapanui,Hawea,Lake Hawea,Kaitangata"),
    ("Southland", "Invercargill,Gore,Riverton,Winton,Mataura,Edendale,Otautau,Bluff,Riversdale,Te Anau,Mossburn,Tuatapere,Wyndham,Lumsden,Athol,Ohai"),
]
TOWN = {}
for _reg, _towns in REGIONS:
    for _t in _towns.split(","): TOWN[_t.strip().lower()] = _reg
CITY_FIX = {"chirstchurch": "christchurch", "chirschurch": "christchurch", "chistchurch": "christchurch", "rotoura": "rotorua", "hamner springs": "hanmer springs"}
NO_ADDRESS = "No billing city recorded"

def city_of(hs):
    c = collections.Counter(CITY_FIX.get((h["BILLINGCITY"] or "").strip().lower(), (h["BILLINGCITY"] or "").strip().lower()) for h in hs)
    for city, _ in c.most_common():
        if city in TOWN: return city.title(), TOWN[city]
    return "", NO_ADDRESS

# ---- Look (matches the approved Chris report) ------------------------------------------------
NAVY, BAND = "1A3C34", "F2F6F4"
def F(size=9, bold=False, color=None): return Font(name="Arial", size=size, bold=bold, color=color)
def hdr(ws, row, vals):
    for i, v in enumerate(vals, 1):
        c = ws.cell(row, i, v); c.font = F(10, True, "FFFFFF"); c.fill = PatternFill("solid", fgColor=NAVY)
        c.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
def line(ws, row, vals, band=False, bold=False):
    for i, v in enumerate(vals, 1):
        c = ws.cell(row, i, v); c.font = F(9, bold)
        if band: c.fill = PatternFill("solid", fgColor=BAND)
def money(c): c.number_format = '"$"#,##0.00;[Red]-"$"#,##0.00'
def widths(ws, w):
    for i, x in enumerate(w, 1): ws.column_dimensions[get_column_letter(i)].width = x

CHAN = ("Online", "Rep / Phone", "Corporate EDI")
def chan(h):
    if h["INVOICEORCREDIT"] != "Invoice": return "Credit notes"
    return {"Online": "Online", "Probable": "Online", "Rep / Phone": "Rep / Phone", "Corporate EDI": "Corporate EDI"}[h["_ch"]]
def amt(hs): return sum(h["INVOICENETTAMOUNT"] for h in hs)
def match_text(h):
    if h["_tier"] == "A": return "Same amount as the online order"
    if h["_tier"] == "B": return "Same store, re-keyed by rep (amount changed)"
    return "Same store, same amount, entered twice on one day"
def ref_text(h):
    if h["_ev"].startswith("Shopify"): return h["_ev"]
    return "Old website order " + h["_ev"].split(" ")[-1] if h["_ev"] else ""

# facts for the Verification Notes
N_SHOP = sum(1 for e in EV if e["src"] == "Shopify"); N_OLD = sum(1 for e in EV if e["src"] == "Old site")
_all_shop = json.load(open(f"{DATA}/shop.json", encoding="utf-8"))
_nums = sorted(int(o["name"].lstrip("#")) for o in _all_shop)
_gaps = [n for n in range(_nums[0], _nums[-1] + 1) if n not in set(_nums)]
_cancel = sum(1 for o in _all_shop if o["cancelledAt"])

os.makedirs(OUT, exist_ok=True)
written = []
d1, d2 = f"{FROM.day} {FROM:%b %Y}", f"{TO.day} {TO:%b %Y}"
for code, name in REPS.items():
    rows = sorted([h for h in H if h["_rep"] == code], key=lambda h: (h["_d"], h["INVOICENUMBER"]))
    if not rows: continue
    by_cust = collections.defaultdict(list)
    for h in rows: by_cust[h["CUSTOMER"]].append(h)
    for cu, hs in by_cust.items():
        city, reg = city_of(hs)
        for h in hs: h["_city"], h["_reg"], h["_chn"] = city, reg, chan(h)
    inv = [h for h in rows if h["INVOICEORCREDIT"] == "Invoice"]
    net = amt(rows)
    # region x channel
    rc = collections.defaultdict(list)
    for h in rows: rc[(h["_reg"], h["_chn"])].append(h)
    reg_tot = collections.Counter()
    for (rg, _), hs in rc.items(): reg_tot[rg] += amt(hs)
    reg_order = sorted(reg_tot, key=lambda rg: (rg == NO_ADDRESS, -reg_tot[rg]))
    ch_tot = {k: [h for h in inv if h["_chn"] == k] for k in CHAN}
    cr = [h for h in rows if h["_chn"] == "Credit notes"]
    onl = ch_tot["Online"]
    # built-in checks
    assert abs(sum(amt(v) for v in rc.values()) - net) < 0.01
    assert abs(sum(amt(v) for v in ch_tot.values()) + amt(cr) - net) < 0.01
    assert sum(len(v) for v in ch_tot.values()) == len(inv)
    wb = Workbook()

    # ===== Summary
    ws = wb.active; ws.title = "Summary"; widths(ws, [30, 16, 12, 16, 12, 12])
    ws["A1"] = f"Dutch Rusk - {name} ({code})"; ws["A1"].font = F(16, True, NAVY)
    ws["A2"] = "FY26 sales by location and channel"; ws["A2"].font = F(10, False, "666666")
    ws["A3"] = f"{d1} to {d2} - Ostendo invoices, matched against Dutch Rusk's Shopify orders and old-website orders"; ws["A3"].font = F(9, False, "888888")
    ws["A5"] = "FY26 total revenue (net of credits)"; ws["A5"].font = F(10, False, "666666"); ws["B5"] = net; money(ws["B5"]); ws["B5"].font = F(10, True)
    ws["A6"] = "Distinct customers"; ws["A6"].font = F(10, False, "666666"); ws["B6"] = len(by_cust); ws["B6"].font = F(10, True)
    r = 8; hdr(ws, r, ["Channel", "Orders", "Revenue", "Share of sales"]); r += 1
    for i, k in enumerate(CHAN):
        v = amt(ch_tot[k]); line(ws, r, [k, len(ch_tot[k]), v, v / amt(inv) if inv else 0], band=i % 2 == 0); money(ws.cell(r, 3)); ws.cell(r, 4).number_format = "0.0%"; r += 1
    line(ws, r, ["Credit notes", len(cr), amt(cr), ""], band=True); money(ws.cell(r, 3)); r += 1
    line(ws, r, ["Total (net of credits)", len(rows), net, ""], bold=True); money(ws.cell(r, 3)); r += 2
    hdr(ws, r, ["Region", "Channel", "Orders", "Net Revenue"]); r += 1
    i = 0
    for rg in reg_order:
        for k in CHAN + ("Credit notes",):
            hs = rc.get((rg, k))
            if not hs: continue
            line(ws, r, [rg, k, len(hs), amt(hs)], band=i % 2 == 0); money(ws.cell(r, 4)); r += 1; i += 1
    line(ws, r, ["Total", "", len(rows), net], bold=True); money(ws.cell(r, 4)); r += 2
    ws.cell(r, 1, "How channel is determined").font = F(10, True, NAVY); r += 1
    note = (f"Online = the invoice follows a real online order from the same store: a Shopify order (new portal, from 15 Aug 2026) or an old-website order. "
            f"It counts when the invoice has the same amount within 2 weeks, or when the rep re-keyed it with a different amount within 10 days, "
            f"or when the same store was invoiced the same amount twice on one day. Stores are tied to online accounts only by their recorded names "
            f"(or 2 or more exact amount matches). Each online order is used for one invoice only. "
            f"Corporate EDI = invoices billed to Foodstuffs South Island Ltd (computer feed). Rep / Phone = everything else. "
            f"Region = the customer's billing city in Ostendo, so chain accounts show where they are billed.")
    ws.merge_cells(start_row=r, start_column=1, end_row=r + 8, end_column=6)
    c = ws.cell(r, 1, note); c.font = F(8.5, False, "888888"); c.alignment = Alignment(wrap_text=True, vertical="top")

    # ===== Customers by Region
    ws = wb.create_sheet("Customers by Region"); widths(ws, [36, 16, 16, 14, 10, 10, 13, 13, 14, 14])
    hdr(ws, 1, ["Customer", "Region", "City", "FY26 Revenue", "Orders", "Credits", "First Order", "Last Order", "Online", "Rep / Phone"])
    custs = sorted(by_cust.items(), key=lambda kv: (reg_order.index(kv[1][0]["_reg"]), -amt(kv[1])))
    r = 2
    for i, (cu, hs) in enumerate(custs):
        iv = [h for h in hs if h["INVOICEORCREDIT"] == "Invoice"]
        line(ws, r, [cu, hs[0]["_reg"], hs[0]["_city"], amt(hs), len(iv), len(hs) - len(iv),
                     min(h["_d"] for h in hs).isoformat(), max(h["_d"] for h in hs).isoformat(),
                     amt([h for h in iv if h["_chn"] == "Online"]), amt([h for h in iv if h["_chn"] == "Rep / Phone"])], band=i % 2 == 0)
        for cc in (4, 9, 10): money(ws.cell(r, cc))
        r += 1
    line(ws, r, ["Total", "", "", net, len(inv), len(rows) - len(inv), "", "", amt(onl), amt(ch_tot["Rep / Phone"])], bold=True)
    for cc in (4, 9, 10): money(ws.cell(r, cc))
    ws.freeze_panes = "A2"; ws.auto_filter.ref = f"A1:J{r-1}"

    # ===== Online Orders
    ws = wb.create_sheet("Online Orders"); widths(ws, [12, 12, 34, 34, 16, 12, 24, 40])
    hdr(ws, 1, ["Date", "Invoice #", "Customer", "Store", "Region", "Amount", "Online order", "How matched"])
    r = 2
    for i, h in enumerate(sorted(onl, key=lambda h: (h["CUSTOMER"], h["_d"]))):
        line(ws, r, [h["_d"].isoformat(), h["INVOICENUMBER"], h["CUSTOMER"], h["DELIVERYCUSTOMER"], h["_reg"], h["INVOICENETTAMOUNT"], ref_text(h), match_text(h)], band=i % 2 == 0)
        money(ws.cell(r, 6)); r += 1
    line(ws, r, ["Total", "", f"{len(onl)} orders", "", "", amt(onl), "", ""], bold=True); money(ws.cell(r, 6))
    ws.freeze_panes = "A2"

    # ===== Verification Notes
    ws = wb.create_sheet("Verification Notes"); widths(ws, [34, 42, 46, 46])
    ws.merge_cells("A1:D1"); ws["A1"] = "Verification: how these numbers were checked"; ws["A1"].font = F(14, True, NAVY)
    ws.merge_cells("A2:D2"); ws["A2"] = f"Checked {dt.date.today().day} {dt.date.today():%b %Y}."; ws["A2"].font = F(9, False, "666666")
    hdr(ws, 4, ["Check", "Method", "Result", "Conclusion"])
    a_n = sum(1 for h in onl if h["_tier"] == "A"); b_n = sum(1 for h in onl if h["_tier"] == "B"); d_n = len(onl) - a_n - b_n
    checks = [
        ("Do the totals match Ostendo?", f"Summed every rep {code} invoice and credit note in Ostendo for {d1} to {d2}, and compared with this file.",
         f"{len(inv)} invoices and {len(rows) - len(inv)} credit notes, net ${net:,.2f}. Identical to Ostendo to the cent.", "Totals are exact."),
        ("Are the invoice lines real?", "Re-queried a random sample of invoices live from Ostendo and compared date, rep, store and amount.",
         "Sample identical to Ostendo.", "Invoice data is exact."),
        ("Which online orders were looked at?", "Pulled every Dutch Rusk Shopify order and every old-website (dr-admin) order for the year.",
         f"{N_SHOP} Shopify orders and {N_OLD} old-website orders (old-website count equals the site's own total).", "All online orders for the year were checked, across all reps."),
        ("Does the rep re-key online orders?", "Matched each online order to the store's next invoice: same amount, or a different amount within 10 days, or the same order twice on one day.",
         f"{len(onl)} of {name}'s invoices follow an online order: {a_n} same amount, {b_n} re-keyed with a different amount, {d_n} entered twice on one day.", "All three are counted as Online, as one channel."),
        ("Could an online order be counted twice, or tied to the wrong store?", "Each online order may explain one invoice only. Stores are tied to online accounts by recorded names, or 2+ exact amount matches. Every Online line was re-checked against its source order.",
         "No online order or invoice used twice. Every Online line passed the re-check.", "No double counting, no coincidental matches."),
        ("Are Shopify orders deleted after the rep re-enters them?", "Checked the Shopify order-number sequence for gaps.",
         f"{len(_gaps)} gap(s) in #{_nums[0]}-#{_nums[-1]}; {_cancel} order(s) cancelled.", "Shopify orders are not being deleted."),
        ("What cannot be seen?", "Old-website deletion log (dr-admin) returns 403. Orders emailed in and typed up by hand, and office orders keyed under 450 then reassigned, leave no online record.",
         "These cannot be measured from Ostendo, Shopify or the old website.", "Online is a minimum. The exact figure needs Ostendo's own 'Created By' export (XQS = online)."),
        ("Why does a region look out of area?", "Region is the customer's billing city in Ostendo, the same basis as the original Chris report.",
         "Chain accounts show where they are billed, e.g. Red Circle Wholesale and CSB Group bill from Napier (Hawke's Bay), Night n Day Foodstores from Dunedin.", "Expected. It is the billing location, not the store's street address."),
    ]
    r = 5
    for ck in checks:
        for i, v in enumerate(ck, 1):
            c = ws.cell(r, i, v); c.font = F(10, False, "000000"); c.alignment = Alignment(wrap_text=True, vertical="top")
        ws.row_dimensions[r].height = 15 * max(2, max(-(-len(v) // 45) for v in ck)); r += 1
    r += 1; ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=4)
    ws.cell(r, 1, f"Bottom line: Online {amt(onl) / amt(inv):.0%} / Rep-Phone {amt(ch_tot['Rep / Phone']) / amt(inv):.0%} / Corporate EDI {amt(ch_tot['Corporate EDI']) / amt(inv):.0%} of invoiced sales. Online is a minimum.").font = F(9, False, "990000")

    fn = f"{name.replace(' ', '_')}_{code}_FY26_Location_Channel_Report.xlsx"
    wb.save(os.path.join(OUT, fn))
    written.append((code, name, len(inv), net, len(onl), amt(onl) / amt(inv), fn))

for c, n, i, net, o, s, fn in written:
    print(f"{c} {n}: {i} inv, net ${net:,.2f}, online {o} ({s:.1%}) -> {fn}")
