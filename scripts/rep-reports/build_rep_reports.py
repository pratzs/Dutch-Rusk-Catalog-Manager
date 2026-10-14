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
               "tok": toks((pe.get("company") or {}).get("name")) | toks((pe.get("location") or {}).get("name")),
               "city": ((((pe.get("location") or {}).get("shippingAddress")) or {}).get("city") or "").strip().lower()})
EV = [e for e in EV if e["d"] >= FROM and e["amt"]]
EV.sort(key=lambda e: e["d"])
INV = [h for h in H if h["INVOICEORCREDIT"] == "Invoice" and h["INVOICENETTAMOUNT"] > 0]
by_day = collections.defaultdict(list)
for h in INV: by_day[h["_d"]].append(h)
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
# A login/company may map to several stores, but only on repeated evidence (one stray vote is not enough).
store_of = {}
for k, c in votes.items():
    top = c.most_common(1)[0][1]
    store_of[k] = {s_ for s_, n in c.items() if n == top or (n >= 2 and n >= 0.3 * top)}
used = set()
def free(h): return id(h) not in used
def link(e, h, tier):
    used.add(id(h)); h["_tier"] = tier; h["_ev"] = f'{e["src"]} {e["id"]}'; e["done"] = True; e["store"] = h["_store"].lower()
def store_ok(e, h):
    st = store_of.get((e["src"], e["user"]))
    if st: return h["_store"].lower() in st
    return bool(e["src"] == "Shopify" and e["tok"] & (toks(h["DELIVERYCUSTOMER"]) | toks(h["CUSTOMER"])))
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
    if h["_shop"] or h.get("_dup"): return "Online"
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
TOWN_BY_LEN = sorted(TOWN, key=len, reverse=True)
CITY_FIX = {"chirstchurch": "christchurch", "chirschurch": "christchurch", "chistchurch": "christchurch", "rotoura": "rotorua", "hamner springs": "hanmer springs"}
REGION_ORDER = [r[0] for r in REGIONS]
# A billed-to account that pays for 3 or more different delivery stores is a chain (head office billing).
_stores_per_bill = collections.defaultdict(set)
for _h in H:
    if _h["INVOICEORCREDIT"] == "Invoice": _stores_per_bill[base(_h["CUSTOMER"]).lower()].add(base(_h["DELIVERYCUSTOMER"] or _h["CUSTOMER"]).lower())
CHAINS = {k for k, v in _stores_per_bill.items() if len(v) >= 3}
UNKNOWN_REGION = "Region not known"


AMBIGUOUS = {"hope", "ward", "milton", "lincoln", "oxford", "richmond", "clyde", "bluff", "hector", "cust", "wakefield", "marlborough", "westland", "west coast", "moana", "pegasus", "burnham", "hamilton", "cambridge", "wellington", "auckland", "nelson", "russell", "winchester", "cobden", "dobson", "athol", "ohai", "rotherham", "sefton", "waiau", "woodend", "tinwald"}
CHAIN_UNKNOWN = "Chain stores (town not recorded)"
# Shopify portal delivery address per Ostendo store. Strict: every word of the store's name must appear in the
# portal company/location name (generic words included), and the store name must have 2+ words. Checked on
# directly-billed stores: 107 of 120 agree with their billing city, most of the rest are the same region.
def _fw(x): return set(re.findall(r"[a-z0-9]{2,}", (x or "").lower()))
_store_names = {base(h["DELIVERYCUSTOMER"] or h["CUSTOMER"]) for h in H}
_store_tok = {st: _fw(st) for st in sorted(_store_names) if len(_fw(st)) >= 2}   # sorted: results must not depend on hash order
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
    """(region, island, town, basis) for one delivery store. Only evidence is used, never a guess:
    1 store billed directly -> its own billing city;
    2 delivery address on the Shopify portal (strict name match);
    3 an unambiguous town in the store's name;
    otherwise the store is placed in a separate group, because a chain head office address is not the store's town."""
    k = store.lower()
    cities = collections.Counter(CITY_FIX.get((h["BILLINGCITY"] or "").strip().lower(), (h["BILLINGCITY"] or "").strip().lower()) for h in hs)
    chain = any(base(h["CUSTOMER"]).lower() in CHAINS for h in hs)
    top_city = next((c for c, _ in cities.most_common() if c in TOWN), None)
    if not chain and top_city:
        return TOWN[top_city][0], TOWN[top_city][1], top_city.title(), "Store's own address"
    sc = CITY_FIX.get(SHOP_STORE_CITY.get(k, ""), SHOP_STORE_CITY.get(k, ""))
    if sc in TOWN:
        return TOWN[sc][0], TOWN[sc][1], sc.title(), "Delivery address on the Shopify portal"
    padded = f" {k} "
    for t in TOWN_BY_LEN:
        if t not in AMBIGUOUS and f" {t} " in padded:
            return TOWN[t][0], TOWN[t][1], t.title(), "Town in the store's name"
    return (CHAIN_UNKNOWN if chain else UNKNOWN_REGION), "", "", "Not recorded"


# ---- Look and feel ---------------------------------------------------------------------------
FONT = "Arial"
def F(size=11, bold=False, color="222222", italic=False): return Font(name=FONT, size=size, bold=bold, color=color, italic=italic)
GREEN, GOLD, CREAM, LINE = "1A3C34", "C9A24A", "FBF6E9", "D9D9D9"
CH_FILL = {"Ordered online": "FCE9B8", "Rep or phone": "DDEBE4", "Foodstuffs head office": "E6E6E6"}
fill = lambda c: PatternFill("solid", fgColor=c)
box = Border(bottom=Side(style="thin", color=LINE))
CHANNELS = ("Ordered online", "Rep or phone", "Foodstuffs head office")

def widths(ws, w):
    for i, x in enumerate(w, 1): ws.column_dimensions[get_column_letter(i)].width = x
def money0(c): c.number_format = '"$"#,##0;[Red]-"$"#,##0'
def pct(c): c.number_format = "0%"
def header(ws, r, vals, h=32):
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

NAMES = {"Online": "Ordered online", "Rep / Phone": "Rep or phone", "Corporate EDI": "Foodstuffs head office", "Credit": "Credit note"}
def nice(h): return NAMES[h["_ch"]]
def amt(hs): return sum(h["INVOICENETTAMOUNT"] for h in hs)
def why(h):
    if h["_tier"] == "A": return f"Same amount as {h['_ev']}"
    if h["_tier"] == "B": return f"The store ordered online ({h['_ev']}) and the rep typed it in again with a different amount"
    return "The same store had the same order twice on the same day, so the rep typed in an online order"

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
    on_ = [h for h in inv if h["_ch"] == "Online"]
    ch = {k: [x for x in inv if nice(x) == k] for k in CHANNELS}
    regs = collections.defaultdict(list)
    for h in inv: regs[h["_reg"]].append(h)
    rl = sorted(regs.items(), key=lambda kv: (kv[0] in (CHAIN_UNKNOWN, UNKNOWN_REGION), -amt(kv[1])))
    uncertain = amt([h for h in inv if h["_basis"] == "Not recorded"])
    # ---- integrity checks: every table must add back to the Ostendo total
    assert abs(sum(amt(v) for v in ch.values()) - gross) < 0.01, "channels do not add up"
    assert abs(sum(amt(v) for _, v in rl) - gross) < 0.01, "regions do not add up"
    assert sum(len(v) for v in ch.values()) == len(inv), "invoice count mismatch"
    wb = Workbook()

    # ============ 1. START HERE
    ws = wb.active; ws.title = "Start Here"; ws.sheet_view.showGridLines = False; widths(ws, [30, 18, 18, 18, 18, 18])
    big_title(ws, f"{name}: sales report", f"Rep code {code}   |   {period} to {endtxt} (this financial year)   |   Asked for by Kishan")
    r = 4; section(ws, r, "What is this?", 6); r += 1
    para(ws, r, f"This lists everything {name}'s customers bought from Dutch Rusk this year, where those customers are, and how each order reached us. It compares orders that came in online with orders the rep took. All money is in New Zealand dollars, before GST.", 6); r += 2
    section(ws, r, "The 3 ways an order can arrive", 6); r += 1
    for lab, txt in (("Ordered online", "The customer ordered on our website, or sent an order by email. The rep usually types it into Ostendo again, so we still count it as an online order."),
                     ("Rep or phone", "The rep took the order by phone, text or face to face."),
                     ("Foodstuffs head office", "Foodstuffs South Island sends its orders by computer (EDI). Nobody types them in.")):
        ws.cell(r, 1, lab).font = F(11, True); ws.cell(r, 1).fill = fill(CH_FILL[lab]); ws.cell(r, 1).alignment = Alignment(vertical="top", wrap_text=True)
        ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=6)
        c = ws.cell(r, 2, txt); c.font = F(); c.alignment = Alignment(wrap_text=True, vertical="top"); ws.row_dimensions[r].height = 16 * max(2, -(-len(txt) // 58)) + 4; r += 1
    r += 1; section(ws, r, "Which page do I open?", 6); r += 1
    for lab, txt in (("Summary", "The whole story on one page: total sales, online against rep, best stores, regions and months."),
                     ("By Region", "Online against rep for each part of New Zealand, a chart, then every store under its region."),
                     ("Online Orders", "Each order we counted as online, and how we know."),
                     ("All Invoices", "Every single invoice and credit note, one per line. You can filter it."),
                     ("How We Worked It Out", "The method in plain words, and what we cannot see.")):
        ws.cell(r, 1, lab).font = F(11, True, GREEN); ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=6); ws.cell(r, 2, txt).font = F(); r += 1
    r += 1; section(ws, r, "Good to know", 6); r += 1
    for t in ("The online number is a minimum. Some online orders leave no trace once the rep types them in, so the real figure is a bit higher.",
              "A credit note is money given back to a customer. Credits are shown separately and taken off at the end.",
              "A region comes from the store's own address, the Shopify portal delivery address, or a town in its name. Chain stores billed through a head office with no other clue are kept in a separate group rather than guessed."):
        para(ws, r, "•  " + t, 6); r += 1

    # ============ 2. SUMMARY
    ws = wb.create_sheet("Summary"); ws.sheet_view.showGridLines = False; widths(ws, [46, 17, 21, 17, 17])
    big_title(ws, f"{name}: the whole story on one page", f"{period} to {endtxt}. Money is before GST.")
    r = 4; section(ws, r, "How much did we sell?", 5); r += 1
    for lab, val, kind in (("Total sales", gross, "$"), ("Money given back (credit notes)", credits, "$"), ("Sales after credit notes", gross - credits, "$"),
                           ("Number of invoices", len(inv), "n"), ("Number of stores that bought", len(by_store), "n")):
        b = lab in ("Total sales", "Sales after credit notes")
        ws.cell(r, 1, lab).font = F(12, b); c = ws.cell(r, 3, val); c.font = F(12, b)
        if kind == "$": money0(c)
        for i in range(1, 6): ws.cell(r, i).border = box
        r += 1
    r += 1; section(ws, r, "Online against rep: side by side", 5); r += 1
    header(ws, r, ["", "Ordered online", "Rep or phone", "Foodstuffs head office", "All orders"], 36); r += 1
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
    oo, rr_ = amt(ch["Ordered online"]), amt(ch["Rep or phone"])
    r += 1; para(ws, r, f"Leaving out Foodstuffs head office orders (nobody types those in), online is {(oo / (oo + rr_) if (oo + rr_) else 0):.0%} of the sales that online and rep or phone brought in together.", 5, chars=88, fillc=CREAM); r += 1
    ws.cell(r, 1, "Inside the online orders:").font = F(11, True, GREEN); r += 1
    header(ws, r, ["", "Invoices", "Sales", "Share of all sales", ""], 24); r += 1
    for lab, sel in (("Same amount as the website or old-site order", lambda h: h["_tier"] == "A"),
                     ("Store ordered online, rep typed it in again (amount changed)", lambda h: h["_tier"] == "B"),
                     ("Same order entered twice on the same day", lambda h: not h["_tier"])):
        ss = [h for h in on_ if sel(h)]
        datarow(ws, r, ["    " + lab, len(ss), amt(ss), amt(ss) / gross if gross else 0]); money0(ws.cell(r, 3)); pct(ws.cell(r, 4)); ws.cell(r, 1).font = F(10, False, "444444"); r += 1
    pos = [h for h in inv if h["_ch"] == "Rep / Phone" and h["_store"].lower() in ONLINE_STORES]
    r += 1; para(ws, r, f"Could some 'rep or phone' orders really be online? Possibly. {len(pos)} of them, worth ${amt(pos):,.0f} ({(amt(pos) / gross if gross else 0):.0%} of sales), came from stores that also order online. We found no matching online order, so we have not counted them as online.", 5, chars=88, fillc=CREAM); r += 2
    section(ws, r, "Top 10 stores", 5); r += 1
    header(ws, r, ["Store (region)", "Invoices", "Sales", "Share of sales", "Online share"]); r += 1; s0 = r
    for st, hs in sorted(by_store.items(), key=lambda kv: -amt(kv[1]))[:10]:
        v = amt(hs); datarow(ws, r, [f"{st} ({hs[0]['_reg']})", len(hs), v, v / gross if gross else 0, amt([h for h in hs if h["_ch"] == "Online"]) / v if v else 0]); money0(ws.cell(r, 3)); pct(ws.cell(r, 4)); pct(ws.cell(r, 5)); r += 1
    bars(ws, f"C{s0}:C{r-1}"); r += 1
    section(ws, r, "Sales by region", 5); r += 1
    header(ws, r, ["Region", "Stores", "Sales", "Share of sales", "Online share"]); r += 1; g0 = r
    for rg, hs in rl:
        v = amt(hs); datarow(ws, r, [rg, len({h["_store"] for h in hs}), v, v / gross if gross else 0, amt([h for h in hs if h["_ch"] == "Online"]) / v if v else 0]); money0(ws.cell(r, 3)); pct(ws.cell(r, 4)); pct(ws.cell(r, 5)); r += 1
    bars(ws, f"C{g0}:C{r-1}"); r += 1
    section(ws, r, "Month by month", 5); r += 1
    header(ws, r, ["Month", "Invoices", "Sales", "Share of sales", "Online share"]); r += 1; m0 = r
    mo = collections.OrderedDict()
    for h in inv: mo.setdefault(h["_d"].strftime("%Y-%m"), []).append(h)
    for k, s in sorted(mo.items()):
        v = amt(s); datarow(ws, r, [dt.datetime.strptime(k, "%Y-%m").strftime("%B %Y"), len(s), v, v / gross if gross else 0, amt([h for h in s if h["_ch"] == "Online"]) / v if v else 0]); money0(ws.cell(r, 3)); pct(ws.cell(r, 4)); pct(ws.cell(r, 5)); r += 1
    bars(ws, f"C{m0}:C{r-1}")
    ws.freeze_panes = "A4"

    # ============ 3. BY REGION
    ws = wb.create_sheet("By Region"); ws.sheet_view.showGridLines = False; widths(ws, [38, 16, 9, 11, 15, 15, 15, 17, 12, 12, 18])
    big_title(ws, f"{name}: online against rep, by region", "Biggest region first. Online share = online sales / all sales in the region. The last column leaves out head office orders, so it compares online with rep or phone only.")
    r = 4; header(ws, r, ["Region", "Island", "Stores", "Invoices", "Sales", "Ordered online", "Rep or phone", "Foodstuffs head office", "Share of all sales", "Online share", "Online share leaving out head office"], 44); r += 1; a0 = r
    for rg, hs in rl:
        v = amt(hs); on = amt([h for h in hs if nice(h) == "Ordered online"])
        datarow(ws, r, [rg, (hs[0]["_isl"] + " Island") if hs[0]["_isl"] else "", len({h["_store"] for h in hs}), len(hs), v, on, amt([h for h in hs if nice(h) == "Rep or phone"]), amt([h for h in hs if nice(h) == "Foodstuffs head office"]), v / gross if gross else 0, on / v if v else 0, on / (on + amt([h for h in hs if nice(h) == "Rep or phone"])) if (on + amt([h for h in hs if nice(h) == "Rep or phone"])) else 0])
        for c in (5, 6, 7, 8): money0(ws.cell(r, c))
        pct(ws.cell(r, 9)); pct(ws.cell(r, 10)); pct(ws.cell(r, 11)); ws.cell(r, 1).font = F(11, True); r += 1
    a1 = r - 1
    datarow(ws, r, ["All regions", "", len(by_store), len(inv), gross, amt(ch["Ordered online"]), amt(ch["Rep or phone"]), amt(ch["Foodstuffs head office"]), 1, amt(ch["Ordered online"]) / gross if gross else 0, amt(ch["Ordered online"]) / (amt(ch["Ordered online"]) + amt(ch["Rep or phone"])) if (amt(ch["Ordered online"]) + amt(ch["Rep or phone"])) else 0], CREAM)
    for c in (5, 6, 7, 8): money0(ws.cell(r, c))
    pct(ws.cell(r, 9)); pct(ws.cell(r, 10)); pct(ws.cell(r, 11))
    for i in range(1, 12): ws.cell(r, i).font = F(11, True)
    bars(ws, f"E{a0}:E{a1}"); r += 2
    para(ws, r, f"Not placed in a region: ${uncertain:,.0f} of sales ({(uncertain / gross if gross else 0):.0%}). These stores are billed through a chain head office and Ostendo does not record the store's own town, so they sit in their own group instead of being guessed. Every other store has a region from its own address, the Shopify portal delivery address, or a town in its name.", 10, chars=130, fillc=CREAM); r += 2
    chart = BarChart(); chart.type = "bar"; chart.style = 10; chart.title = "Online against rep or phone, by region ($)"; chart.grouping = "clustered"
    nrows = min(len(rl), 12)
    chart.add_data(Reference(ws, min_col=6, max_col=7, min_row=4, max_row=4 + nrows), titles_from_data=True)
    chart.set_categories(Reference(ws, min_col=1, min_row=5, max_row=4 + nrows))
    chart.y_axis.numFmt = '"$"#,##0'; chart.x_axis.scaling.orientation = "maxMin"; chart.height = 11; chart.width = 26
    chart.y_axis.delete = False; chart.x_axis.delete = False
    ws.add_chart(chart, f"A{r}"); r += 24
    section(ws, r, "Every store, under its region", 10); r += 1
    header(ws, r, ["Store", "Town", "Invoices", "Last order", "Sales", "Ordered online", "Rep or phone", "Foodstuffs head office", "Online share", "Region based on"], 44); r += 1
    widths_note = ws.column_dimensions["J"]; widths_note.width = 34
    for rg, hs in rl:
        for i in range(1, 11): ws.cell(r, i).fill = fill(GREEN)
        ws.cell(r, 1, f"{rg}  ({len({h['_store'] for h in hs})} stores)").font = F(12, True, "FFFFFF"); c = ws.cell(r, 5, amt(hs)); c.font = F(12, True, "FFFFFF"); money0(c); r += 1
        sts = collections.defaultdict(list)
        for h in hs: sts[h["_store"]].append(h)
        for st, ss in sorted(sts.items(), key=lambda kv: -amt(kv[1])):
            v = amt(ss); on = amt([h for h in ss if nice(h) == "Ordered online"])
            datarow(ws, r, [st, ss[0]["_town"], len(ss), max(h["_d"] for h in ss), v, on, amt([h for h in ss if nice(h) == "Rep or phone"]), amt([h for h in ss if nice(h) == "Foodstuffs head office"]), on / v if v else 0, ss[0]["_basis"]])
            ws.cell(r, 4).number_format = "d mmm yyyy"
            for c in (5, 6, 7, 8): money0(ws.cell(r, c))
            pct(ws.cell(r, 9))
            if ss[0]["_basis"] == "Not recorded": ws.cell(r, 10).font = F(10, False, "B45309", True)
            r += 1
    ws.freeze_panes = "A5"

    # ============ 4. ONLINE ORDERS
    ws = wb.create_sheet("Online Orders"); ws.sheet_view.showGridLines = False; widths(ws, [14, 14, 40, 16, 22, 90])
    big_title(ws, f"{name}: orders we counted as online", "One line per invoice. The last column says how we know.")
    r = 4; header(ws, r, ["Date", "Invoice", "Store", "Sales", "Region", "How we know it was online"]); r += 1
    for h in on_:
        datarow(ws, r, [h["_d"], h["INVOICENUMBER"], h["_store"], h["INVOICENETTAMOUNT"], h["_reg"], why(h)]); ws.cell(r, 1).number_format = "d mmm yyyy"; money0(ws.cell(r, 4)); r += 1
    datarow(ws, r, ["Total", "", f"{len(on_)} invoices", amt(on_), "", ""], CREAM); money0(ws.cell(r, 4))
    for i in range(1, 7): ws.cell(r, i).font = F(11, True)
    ws.freeze_panes = "A5"; ws.auto_filter.ref = f"A4:F{max(r - 1, 5)}"

    # ============ 5. ALL INVOICES
    ws = wb.create_sheet("All Invoices"); ws.sheet_view.showGridLines = False; widths(ws, [14, 14, 14, 36, 36, 22, 16, 22, 18])
    big_title(ws, f"{name}: every invoice and credit note", "Use the little arrows in the header row to filter by store, region or way it arrived.")
    r = 4; header(ws, r, ["Date", "Invoice", "Type", "Billed to", "Store", "Region", "Amount", "How it arrived", "Ostendo order no."]); r += 1
    for h in rows:
        datarow(ws, r, [h["_d"], h["INVOICENUMBER"], "Credit note" if h["INVOICEORCREDIT"] != "Invoice" else "Invoice", h["CUSTOMER"], h["DELIVERYCUSTOMER"], h["_reg"], h["INVOICENETTAMOUNT"], nice(h), h["GROUPORDERNUMBERS"]])
        ws.cell(r, 1).number_format = "d mmm yyyy"; money0(ws.cell(r, 7))
        if nice(h) in CH_FILL: ws.cell(r, 8).fill = fill(CH_FILL[nice(h)])
        r += 1
    ws.freeze_panes = "A5"; ws.auto_filter.ref = f"A4:I{r-1}"

    # ============ 6. HOW WE WORKED IT OUT
    ws = wb.create_sheet("How We Worked It Out"); ws.sheet_view.showGridLines = False; widths(ws, [28, 104])
    big_title(ws, "How we worked it out", f"Made {dt.date.today().day} {dt.date.today():%B %Y}")
    a_n = sum(1 for h in on_ if h["_tier"] == "A"); b_n = sum(1 for h in on_ if h["_tier"] == "B"); d_n = sum(1 for h in on_ if not h["_tier"])
    notes = [("Where the numbers come from", "Ostendo, our invoicing system. Every invoice and credit note with this rep's code on it. Amounts are before GST. Cancelled (reversed) invoices are left out."),
             ("Which invoices are the rep's", f"Anything with rep code {code}. Codes like {code}-1 are the same rep, so they are included."),
             ("How we spot online orders", "A customer orders on the website. Admin sends the order to the rep. The rep types it into Ostendo again, often with different discounts, and the website order is deleted. So the amounts often no longer match, and we have to look for clues."),
             ("Clue 1: same amount", f"A website or old-site order has the same amount as an invoice for the same store, within two weeks. ({a_n} invoices)"),
             ("Clue 2: same store, new amount", f"The store ordered online, and an invoice for that store followed within 10 days at a similar amount (half to one and a half times). ({b_n} invoices)"),
             ("Clue 3: twice in one day", f"The same store has the same amount twice on one day. The rep typed an online order in again. ({d_n} invoices)"),
             ("Where the online orders came from", f"The new Shopify website (since 15 August 2026) and the old website. We read {EV_TOTAL} online orders for the year across all reps, and {len(EV_UNMATCHED)} of them could not be tied to any invoice."),
             ("What we cannot see", "Orders emailed in and typed up by hand leave no trace. Orders the office typed in under code 450 and handed to a rep later leave no trace either. So 'online' is a minimum. The Summary page shows how much 'rep or phone' came from stores that also order online."),
             ("Foodstuffs head office", "Orders billed to Foodstuffs South Island Ltd arrive by computer (EDI). They are kept in their own group. Other chains may need to be added: ask Kishan."),
             ("Regions", "Ostendo has no delivery address. A region comes from (1) the store's own billing address when the store is billed directly, (2) the delivery address on the Shopify portal (the store's full name must match), or (3) an unambiguous town in the store's name, for example 'Four Square Alexandra'. Chain head office addresses are never used, because they are not where the store is. Stores with none of these are in a separate group. The By Region page shows how much money that is."),
             ("Checks built in", "Before this file was saved the computer checked that online + rep + head office = total sales, that the regions add up to total sales, and that the invoice counts match. If any check failed the file would not have been made.")]
    r = 4; header(ws, r, ["Topic", "What we did"], 28); r += 1
    for t, n in notes:
        ws.cell(r, 1, t).font = F(11, True, GREEN); ws.cell(r, 1).alignment = Alignment(wrap_text=True, vertical="top")
        c = ws.cell(r, 2, n); c.font = F(); c.alignment = Alignment(wrap_text=True, vertical="top"); ws.row_dimensions[r].height = 16 * max(1, -(-len(n) // 105)) + 6
        for i in (1, 2): ws.cell(r, i).border = box
        r += 1
    fn = f"{name.replace(' ', '_')}_{code}_FY26_Sales_Report.xlsx"
    wb.save(os.path.join(OUT, fn)); written.append((code, name, len(inv), gross, credits, len(on_), uncertain, fn))

for c, n, i, g, cr, o, u, fn in written:
    print(f"{c} {n}: {i} inv, ${g:,.2f}, credits ${cr:,.2f}, online inv {o}, uncertain-region ${u:,.0f} -> {fn}")
