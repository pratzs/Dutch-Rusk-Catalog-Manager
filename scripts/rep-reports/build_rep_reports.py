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
    if h["INVOICEORCREDIT"] == "Invoice": grp[(h["_store"].lower(), h["_d"], round(h["INVOICENETTAMOUNT"], 2))].append(h)
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
# Ostendo has only a billing city, so towns are mapped to NZ regions here (regional council areas).
from openpyxl.formatting.rule import DataBarRule
from openpyxl.chart import BarChart, Reference

REGIONS = [
    ("Auckland", "North", "Auckland,Pukekohe"),
    ("Northland", "North", "Whangarei,Russell"),
    ("Waikato", "North", "Hamilton,Cambridge,Morrinsville,Te Kowhai,Whitianga,Hot Water Beach,Taupo"),
    ("Bay of Plenty", "North", "Tauranga,Rotorua,Whakatane,Ohope"),
    ("Taranaki", "North", "New Plymouth"),
    ("Hawke's Bay", "North", "Napier,Waipawa,Waipukurau"),
    ("Manawatu-Whanganui", "North", "Palmerston North,Feilding,Whanganui,Levin"),
    ("Wellington", "North", "Wellington,Porirua,Lower Hutt"),
    ("Nelson-Tasman", "South", "Nelson,Motueka,Richmond,Upper Moutere,Takaka,Collingwood,Tapawera,Mapua,Riwaka,Wakefield,Spring Grove,Hope,Murchison"),
    ("Marlborough", "South", "Blenheim,Picton,Havelock,Renwick,Seddon,Marlborough,Ward"),
    ("West Coast", "South", "Greymouth,Westport,Hokitika,Reefton,Runanga,Blackball,Cobden,Springs Junction,West Coast,Westland,Hari Hari,Fox Glacier,Hector,Moana,Haast,Franz Josef,Karamea,Dobson"),
    ("Canterbury", "South", "Christchurch,Ashburton,Timaru,Rangiora,Darfield,Rolleston,Hanmer Springs,Kirwee,Kaiapoi,Amberley,Waimate,Oxford,Kaikoura,Geraldine,Methven,Waikari,Sefton,Temuka,Waiau,Pegasus,Lincoln,Tinwald,Woodend,Mount Hutt,Pareora,Akaroa,Winchester,Aoraki Mt Cook,Cust,Burnham,Leeston,Rotherham,Springston,Southbridge,Rakaia,St Andrews,Twizel,Fairlie,Tekapo,Lyttelton,Prebbleton,Halswell"),
    ("Otago", "South", "Dunedin,Dunedin Central,Oamaru,Cromwell,Queenstown,Arrowtown,Ranfurly,Omakau,Waikouaiti,Balclutha,Alexandra,Mosgiel,Milton,Ettrick,Wanaka,Waihola,Otematata,Clyde,Kurow,Omarama,Palmerston,Roxburgh,Lawrence,Tapanui,Hawea,Lake Hawea,Kaitangata"),
    ("Southland", "South", "Invercargill,Gore,Riverton,Winton,Mataura,Edendale,Otautau,Bluff,Riversdale,Te Anau,Mossburn,Tuatapere,Wyndham,Lumsden,Athol,Ohai"),
]
TOWN = {}
for _reg, _isl, _towns in REGIONS:
    for _t in _towns.split(","): TOWN[_t.strip().lower()] = (_reg, _isl)
CITY_FIX = {"chirstchurch": "christchurch", "chirschurch": "christchurch", "chistchurch": "christchurch", "rotoura": "rotorua", "hamner springs": "hanmer springs"}
NOT_PLACED = "Not placed (town not recorded)"

# A billed-to account that pays for 3 or more different delivery stores is a chain (head office billing).
_stores_per_bill = collections.defaultdict(set)
for _h in H:
    if _h["INVOICEORCREDIT"] == "Invoice": _stores_per_bill[base(_h["CUSTOMER"]).lower()].add(base(_h["DELIVERYCUSTOMER"] or _h["CUSTOMER"]).lower())
CHAINS = {k for k, v in _stores_per_bill.items() if len(v) >= 3}

# Shopify portal delivery address per Ostendo store. Strict: every word of the store's name must appear in the portal
# company/location name, and the store name must have 2+ words. (Checked on directly billed stores: 107 of 120 agree
# with their billing city, nearly all the rest are the same region.)
def _fw(x): return set(re.findall(r"[a-z0-9]{2,}", (x or "").lower()))
_store_names = {base(h["DELIVERYCUSTOMER"] or h["CUSTOMER"]) for h in H}
_store_tok = {st: _fw(st) for st in sorted(_store_names) if len(_fw(st)) >= 2}
_sc = collections.defaultdict(collections.Counter)
for _o in O:
    _pe = _o["purchasingEntity"] or {}; _loc = _pe.get("location") or {}
    _city = (((_loc.get("shippingAddress")) or {}).get("city") or "").strip().lower()
    _ct = _fw((_pe.get("company") or {}).get("name")) | _fw(_loc.get("name"))
    _best = None
    for _st, _tk in _store_tok.items():
        if _tk <= _ct and (_best is None or len(_tk) > len(_best[1])): _best = (_st, _tk)
    if _best and _city: _sc[_best[0].lower()][_city] += 1
SHOP_STORE_CITY = {k: c.most_common(1)[0][0] for k, c in _sc.items()}


def store_region(store, hs):
    """(region, island, town, basis). Recorded addresses only, never a guess:
    1 a store billed directly: the billing city on its own invoices;
    2 the delivery address on the Shopify portal when the store's full name matches;
    otherwise not placed (a chain head office address is not the store's town)."""
    k = store.lower()
    cities = collections.Counter(CITY_FIX.get((h["BILLINGCITY"] or "").strip().lower(), (h["BILLINGCITY"] or "").strip().lower()) for h in hs)
    chain = any(base(h["CUSTOMER"]).lower() in CHAINS for h in hs)
    top_city = next((c for c, _ in cities.most_common() if c in TOWN), None)
    if not chain and top_city:
        return TOWN[top_city][0], TOWN[top_city][1], top_city.title(), "Store's own billing address"
    sc = CITY_FIX.get(SHOP_STORE_CITY.get(k, ""), SHOP_STORE_CITY.get(k, ""))
    if sc in TOWN:
        return TOWN[sc][0], TOWN[sc][1], sc.title(), "Shopify portal delivery address"
    return NOT_PLACED, "", "", "Not recorded"


# ---- Look and feel ---------------------------------------------------------------------------
FONT = "Arial"
def F(size=11, bold=False, color="222222", italic=False): return Font(name=FONT, size=size, bold=bold, color=color, italic=italic)
GREEN, GOLD, CREAM, LINE = "1A3C34", "C9A24A", "FBF6E9", "D9D9D9"
CHANNELS = ("Online", "Rep or phone", "Foodstuffs head office")
CH_FILL = {"Online": "FCE9B8", "Rep or phone": "DDEBE4", "Foodstuffs head office": "E6E6E6"}
fill = lambda c: PatternFill("solid", fgColor=c)
box = Border(bottom=Side(style="thin", color=LINE))

def widths(ws, w):
    for i, x in enumerate(w, 1): ws.column_dimensions[get_column_letter(i)].width = x
def money0(c): c.number_format = '"$"#,##0;[Red]-"$"#,##0'
def pct(c): c.number_format = "0%"
def header(ws, r, vals, h=34):
    for i, v in enumerate(vals, 1):
        c = ws.cell(r, i, v); c.font = F(11, True, "FFFFFF"); c.fill = fill(GREEN)
        c.alignment = Alignment(horizontal="center" if i > 1 else "left", vertical="center", wrap_text=True)
    ws.row_dimensions[r].height = h
def big_title(ws, text, sub=None):
    ws["A1"] = text; ws["A1"].font = F(20, True, GREEN); ws.row_dimensions[1].height = 34
    if sub: ws["A2"] = sub; ws["A2"].font = F(11, False, "666666", True)
def section(ws, r, text, ncol):
    ws.cell(r, 1, text).font = F(14, True, GREEN)
    for i in range(1, ncol + 1): ws.cell(r, i).border = Border(bottom=Side(style="medium", color=GOLD))
    ws.row_dimensions[r].height = 26
def para(ws, r, text, ncol, chars=95, fillc=None, bold=False):
    ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=ncol)
    c = ws.cell(r, 1, text); c.font = F(11, bold); c.alignment = Alignment(wrap_text=True, vertical="top")
    if fillc:
        for i in range(1, ncol + 1): ws.cell(r, i).fill = fill(fillc)
    ws.row_dimensions[r].height = 16 * max(1, -(-len(text) // chars)) + 4
def datarow(ws, r, vals, shade=None):
    for i, v in enumerate(vals, 1):
        c = ws.cell(r, i, v); c.font = F(); c.border = box; c.alignment = Alignment(vertical="center", wrap_text=(i == 1))
        if shade: c.fill = fill(shade)
def bars(ws, rng): ws.conditional_formatting.add(rng, DataBarRule(start_type="num", start_value=0, end_type="max", color=GOLD, showValue=True))

def nice(h):
    if h["INVOICEORCREDIT"] != "Invoice": return "Credit note"
    return {"Online": "Online", "Probable": "Online", "Rep / Phone": "Rep or phone", "Corporate EDI": "Foodstuffs head office"}[h["_ch"]]
def amt(hs): return sum(h["INVOICENETTAMOUNT"] for h in hs)
def proof(h):
    if h["_tier"] == "A": return f"{h['_ev']}: same store, same amount, invoiced within 2 weeks"
    if h["_tier"] == "B": return f"{h['_ev']}: same store ordered online, invoice came within 10 days with a different amount"
    return "Same store, same amount, same day, twice on one invoice date"

os.makedirs(OUT, exist_ok=True)
written = []
period = f"{FROM.day} {FROM:%B %Y}"; endtxt = f"{TO.day} {TO:%B %Y}"
for code, name in REPS.items():
    rows = sorted([h for h in H if h["_rep"] == code], key=lambda h: (h["_d"], h["INVOICENUMBER"]))
    if not rows: continue
    inv = [h for h in rows if h["INVOICEORCREDIT"] == "Invoice"]; cr = [h for h in rows if h["INVOICEORCREDIT"] != "Invoice"]
    gross = amt(inv); credits = -amt(cr)
    by_store = collections.defaultdict(list)
    for h in inv: by_store[h["_store"]].append(h)
    for st, hs in by_store.items():
        reg, isl, town, basis = store_region(st, hs)
        for h in hs: h["_reg"], h["_isl"], h["_town"], h["_basis"] = reg, isl, town, basis
    for h in cr: h["_reg"] = ""; h["_isl"] = ""; h["_town"] = ""; h["_basis"] = ""
    ch = {k: [x for x in inv if nice(x) == k] for k in CHANNELS}
    onl = ch["Online"]
    regs = collections.defaultdict(list)
    for h in inv: regs[h["_reg"]].append(h)
    rl = sorted(regs.items(), key=lambda kv: (kv[0] == NOT_PLACED, -amt(kv[1])))
    unplaced = amt(regs.get(NOT_PLACED, []))
    # ---- built-in checks: every table must add back to the Ostendo total
    assert abs(sum(amt(v) for v in ch.values()) - gross) < 0.01, "channels do not add up"
    assert abs(sum(amt(v) for _, v in rl) - gross) < 0.01, "regions do not add up"
    assert sum(len(v) for v in ch.values()) == len(inv), "invoice count mismatch"
    wb = Workbook()

    # ============ 1. SUMMARY
    ws = wb.active; ws.title = "Summary"; ws.sheet_view.showGridLines = False; widths(ws, [46, 17, 17, 17, 20, 15])
    big_title(ws, f"{name} (rep code {code}): sales report", f"{period} to {endtxt}. Money is before GST. Requested by Kishan.")
    r = 4
    para(ws, r, "Online = the store ordered through the new website or the old website, and the order was then invoiced (the rep often types it into Ostendo again). Rep or phone = no online order found. Foodstuffs head office = billed to Foodstuffs South Island Ltd, orders arrive by computer.", 6, chars=100, fillc=CREAM); r += 2
    section(ws, r, "Sales", 6); r += 1
    for lab, val, kind in (("Total sales", gross, "$"), ("Credit notes (money given back)", credits, "$"), ("Sales after credit notes", gross - credits, "$"),
                           ("Invoices", len(inv), "n"), ("Stores that bought", len(by_store), "n")):
        b = lab in ("Total sales", "Sales after credit notes")
        ws.cell(r, 1, lab).font = F(12, b); c = ws.cell(r, 3, val); c.font = F(12, b)
        if kind == "$": money0(c)
        for i in range(1, 7): ws.cell(r, i).border = box
        r += 1
    r += 1; section(ws, r, "Online against rep", 6); r += 1
    header(ws, r, ["", "Online", "Rep or phone", "Foodstuffs head office", "All orders"], 40); r += 1
    def avg(v): return (amt(v) / len(v)) if v else 0
    side = (("Invoices", [len(ch[k]) for k in CHANNELS] + [len(inv)], "n"),
            ("Sales", [amt(ch[k]) for k in CHANNELS] + [gross], "$"),
            ("Share of all sales", [amt(ch[k]) / gross if gross else 0 for k in CHANNELS] + [1], "%"),
            ("Average invoice", [avg(ch[k]) for k in CHANNELS] + [avg(inv)], "$"),
            ("Stores", [len({h["_store"] for h in ch[k]}) for k in CHANNELS] + [len(by_store)], "n"))
    for lab, vals, kind in side:
        datarow(ws, r, [lab] + vals); ws.cell(r, 1).font = F(11, True)
        for i, k in enumerate(CHANNELS, 2): ws.cell(r, i).fill = fill(CH_FILL[k])
        for i in range(2, 6):
            ws.cell(r, i).alignment = Alignment(horizontal="right", vertical="center")
            if kind == "$": money0(ws.cell(r, i))
            elif kind == "%": pct(ws.cell(r, i))
        r += 1
    oo, rr_ = amt(onl), amt(ch["Rep or phone"])
    r += 1; para(ws, r, f"Online is {(amt(onl) / gross if gross else 0):.1%} of total sales, and {(oo / (oo + rr_) if (oo + rr_) else 0):.1%} of the sales that online and rep or phone brought in together (leaving out Foodstuffs head office). Online orders that left no trace in Ostendo, Shopify or the old website are not counted, so online is a minimum.", 6, chars=100); r += 2
    section(ws, r, "Top 10 stores", 6); r += 1
    header(ws, r, ["Store (region)", "Invoices", "Sales", "Share of sales", "Online share", ""]); r += 1; s0 = r
    for st, hs in sorted(by_store.items(), key=lambda kv: -amt(kv[1]))[:10]:
        v = amt(hs); datarow(ws, r, [f"{st} ({hs[0]['_reg']})", len(hs), v, v / gross if gross else 0, amt([h for h in hs if nice(h) == 'Online']) / v if v else 0]); money0(ws.cell(r, 3)); pct(ws.cell(r, 4)); pct(ws.cell(r, 5)); r += 1
    bars(ws, f"C{s0}:C{r-1}"); r += 1
    section(ws, r, "Month by month", 6); r += 1
    header(ws, r, ["Month", "Invoices", "Sales", "Share of sales", "Online share", ""]); r += 1; m0 = r
    mo = collections.OrderedDict()
    for h in inv: mo.setdefault(h["_d"].strftime("%Y-%m"), []).append(h)
    for k, s in sorted(mo.items()):
        v = amt(s); datarow(ws, r, [dt.datetime.strptime(k, "%Y-%m").strftime("%B %Y"), len(s), v, v / gross if gross else 0, amt([h for h in s if nice(h) == "Online"]) / v if v else 0]); money0(ws.cell(r, 3)); pct(ws.cell(r, 4)); pct(ws.cell(r, 5)); r += 1
    bars(ws, f"C{m0}:C{r-1}")
    ws.freeze_panes = "A4"

    # ============ 2. BY REGION
    ws = wb.create_sheet("By Region"); ws.sheet_view.showGridLines = False; widths(ws, [38, 16, 8, 10, 14, 14, 14, 16, 12, 14])
    big_title(ws, f"{name}: online against rep, by region", "Biggest region first. Online share = online sales divided by all sales in the region.")
    r = 4; header(ws, r, ["Region", "Island", "Stores", "Invoices", "Sales", "Online", "Rep or phone", "Foodstuffs head office", "Share of all sales", "Online share"], 44); r += 1; a0 = r
    def regvals(hs):
        v = amt(hs); sv = lambda k: amt([h for h in hs if nice(h) == k])
        return [v, sv("Online"), sv("Rep or phone"), sv("Foodstuffs head office")]
    for rg, hs in rl:
        v, c1, c2, c3 = regvals(hs)
        datarow(ws, r, [rg, (hs[0]["_isl"] + " Island") if hs[0]["_isl"] else "", len({h["_store"] for h in hs}), len(hs), v, c1, c2, c3, v / gross if gross else 0, c1 / v if v else 0])
        for c in (5, 6, 7, 8): money0(ws.cell(r, c))
        pct(ws.cell(r, 9)); pct(ws.cell(r, 10)); ws.cell(r, 1).font = F(11, True); r += 1
    a1 = r - 1
    v, c1, c2, c3 = regvals(inv)
    datarow(ws, r, ["All regions", "", len(by_store), len(inv), v, c1, c2, c3, 1, c1 / v if v else 0], CREAM)
    for c in (5, 6, 7, 8): money0(ws.cell(r, c))
    pct(ws.cell(r, 9)); pct(ws.cell(r, 10))
    for i in range(1, 11): ws.cell(r, i).font = F(11, True)
    bars(ws, f"E{a0}:E{a1}"); r += 2
    para(ws, r, f"Not placed: ${unplaced:,.0f} of sales ({(unplaced / gross if gross else 0):.0%}). These stores are billed through a chain head office and Ostendo does not record the store's own town. They are not guessed. Every placed store uses a recorded address: its own billing address, or the delivery address on the Shopify portal where the store's full name matches.", 10, chars=140, fillc=CREAM); r += 2
    chart = BarChart(); chart.type = "bar"; chart.style = 10; chart.title = "Online against rep or phone, by region ($)"; chart.grouping = "clustered"
    nrows = min(len(rl), 12)
    chart.add_data(Reference(ws, min_col=6, max_col=7, min_row=4, max_row=4 + nrows), titles_from_data=True)
    chart.set_categories(Reference(ws, min_col=1, min_row=5, max_row=4 + nrows))
    chart.y_axis.numFmt = '"$"#,##0'; chart.x_axis.scaling.orientation = "maxMin"; chart.height = 11; chart.width = 26
    chart.y_axis.delete = False; chart.x_axis.delete = False
    ws.add_chart(chart, f"A{r}"); r += 24
    section(ws, r, "Every store, under its region", 10); r += 1
    header(ws, r, ["Store", "Town", "Invoices", "Last order", "Sales", "Online", "Rep or phone", "Foodstuffs head office", "Online share", "Region based on"], 44); r += 1
    ws.column_dimensions["J"].width = 30
    for rg, hs in rl:
        for i in range(1, 11): ws.cell(r, i).fill = fill(GREEN)
        ws.cell(r, 1, f"{rg}  ({len({h['_store'] for h in hs})} stores)").font = F(12, True, "FFFFFF"); c = ws.cell(r, 5, amt(hs)); c.font = F(12, True, "FFFFFF"); money0(c); r += 1
        sts = collections.defaultdict(list)
        for h in hs: sts[h["_store"]].append(h)
        for st, ss in sorted(sts.items(), key=lambda kv: -amt(kv[1])):
            v, c1, c2, c3 = regvals(ss)
            datarow(ws, r, [st, ss[0]["_town"], len(ss), max(h["_d"] for h in ss), v, c1, c2, c3, c1 / v if v else 0, ss[0]["_basis"]])
            ws.cell(r, 4).number_format = "d mmm yyyy"
            for c in (5, 6, 7, 8): money0(ws.cell(r, c))
            pct(ws.cell(r, 9)); r += 1
    ws.freeze_panes = "A5"

    # ============ 3. ONLINE ORDERS
    ws = wb.create_sheet("Online Orders"); ws.sheet_view.showGridLines = False; widths(ws, [14, 14, 40, 16, 20, 100])
    big_title(ws, f"{name}: orders counted as online", "One line per invoice, with the proof.")
    r = 4; header(ws, r, ["Date", "Invoice", "Store", "Sales", "Region", "Proof"]); r += 1
    for h in onl:
        datarow(ws, r, [h["_d"], h["INVOICENUMBER"], h["_store"], h["INVOICENETTAMOUNT"], h["_reg"], proof(h)]); ws.cell(r, 1).number_format = "d mmm yyyy"; money0(ws.cell(r, 4)); r += 1
    datarow(ws, r, ["Total", "", f"{len(onl)} invoices", amt(onl), "", ""], CREAM); money0(ws.cell(r, 4))
    for i in range(1, 7): ws.cell(r, i).font = F(11, True)
    ws.freeze_panes = "A5"; ws.auto_filter.ref = f"A4:F{max(r - 1, 5)}"

    # ============ 4. ALL INVOICES
    ws = wb.create_sheet("All Invoices"); ws.sheet_view.showGridLines = False; widths(ws, [14, 14, 14, 36, 36, 26, 16, 22, 18])
    big_title(ws, f"{name}: every invoice and credit note", "Filter with the arrows in the header row.")
    r = 4; header(ws, r, ["Date", "Invoice", "Type", "Billed to", "Store", "Region", "Amount", "How it arrived", "Ostendo order no."]); r += 1
    for h in rows:
        datarow(ws, r, [h["_d"], h["INVOICENUMBER"], "Credit note" if h["INVOICEORCREDIT"] != "Invoice" else "Invoice", h["CUSTOMER"], h["DELIVERYCUSTOMER"], h["_reg"], h["INVOICENETTAMOUNT"], nice(h), h["GROUPORDERNUMBERS"]])
        ws.cell(r, 1).number_format = "d mmm yyyy"; money0(ws.cell(r, 7))
        if nice(h) in CH_FILL: ws.cell(r, 8).fill = fill(CH_FILL[nice(h)])
        r += 1
    ws.freeze_panes = "A5"; ws.auto_filter.ref = f"A4:I{r-1}"

    # ============ 5. HOW THIS WAS WORKED OUT
    ws = wb.create_sheet("Method and Limits"); ws.sheet_view.showGridLines = False; widths(ws, [28, 104])
    big_title(ws, "Method and limits", f"Made {dt.date.today().day} {dt.date.today():%B %Y}")
    a_n, b_n, d_n = sum(1 for h in onl if h["_tier"] == "A"), sum(1 for h in onl if h["_tier"] == "B"), sum(1 for h in onl if not h["_tier"])
    notes = [("Source", f"Ostendo invoices and credit notes with rep code {code} (and {code}-1 style codes), {period} to {endtxt}. Amounts are before GST. Reversed invoices are left out. Totals were checked against Ostendo to the cent."),
             ("Online orders read", f"New Shopify website (since 15 August 2026) and the old website (dr-admin). {EV_TOTAL} online orders were read for the year across all reps."),
             ("What counts as Online", f"{len(onl)} invoices. The store is linked to an online login or company by its recorded name (or 2 or more exact amount matches), and an invoice for that store followed one of its online orders: {a_n} with the same amount within 2 weeks, {b_n} within 10 days at a different amount (the rep typed it in again with different discounts), and {d_n} where the same store was invoiced the same amount twice on one day. One online order is used for one invoice only."),
             ("Not counted as online", "Orders emailed in and typed up by hand, and orders the office typed under code 450 and handed to a rep later, leave no trace in Ostendo, Shopify or the old website. They sit under Rep or phone. Online is therefore a minimum."),
             ("Foodstuffs head office", "Invoices billed to Foodstuffs South Island Ltd. Other chains have not been separated."),
             ("Regions", "Ostendo has no delivery address. A store gets a region only from a recorded address: its own billing city (stores billed directly), or the delivery address on the Shopify portal when every word of the store's name matches the portal company name. Stores billed through a chain head office with no match are shown as Not placed."),
             ("Checks", "Before saving, the computer checks that online + rep + head office equals total sales, that the regions add up to total sales, and that invoice counts match. Totals, credits and counts were also compared with raw Ostendo for each rep code.")]
    r = 4; header(ws, r, ["Topic", "Detail"], 28); r += 1
    for t, n in notes:
        ws.cell(r, 1, t).font = F(11, True, GREEN); ws.cell(r, 1).alignment = Alignment(wrap_text=True, vertical="top")
        c = ws.cell(r, 2, n); c.font = F(); c.alignment = Alignment(wrap_text=True, vertical="top"); ws.row_dimensions[r].height = 16 * max(1, -(-len(n) // 105)) + 6
        for i in (1, 2): ws.cell(r, i).border = box
        r += 1
    fn = f"{name.replace(' ', '_')}_{code}_FY26_Sales_Report.xlsx"
    wb.save(os.path.join(OUT, fn)); written.append((code, name, len(inv), gross, credits, len(ch["Online"]), 0, unplaced, fn))

for c, n, i, g, cr, o1, o2, u, fn in written:
    print(f"{c} {n}: {i} inv, ${g:,.2f}, credits ${cr:,.2f}, online {o1}, not placed ${u:,.0f} -> {fn}")
