"""Independent audit of the finished rep workbooks. Does not import the builder.
usage: audit.py DATA_DIR OUT_DIR   (needs OSTENDO_BASE_URL / OSTENDO_API_KEY in env for the live spot check)"""
import json, glob, os, re, sys, random, datetime as dt, collections, urllib.request, ssl
import openpyxl

DATA, OUT = sys.argv[1], sys.argv[2]
pd = lambda s: dt.datetime.strptime(s, "%d/%m/%Y").date()
H = json.load(open(DATA + "/hdr.json", encoding="utf-8"))
RAW = {}
for h in H: RAW[h["INVOICENUMBER"]] = h
# online source orders
EV = {}
for l in open(DATA + "/oldsite.txt", encoding="utf-8").read().split(chr(10)):
    if not l: continue
    i, u, c, st, at, t = l.split("|")
    m = re.match(r"(\w+)\.? (\d+), (\d+)", at)
    EV["Old site " + i] = (dt.datetime.strptime(f"{m.group(1)[:3]} {m.group(2)} {m.group(3)}", "%b %d %Y").date(), float(t) if t else None, u)
for o in json.load(open(DATA + "/shop.json", encoding="utf-8")):
    d = dt.datetime.fromisoformat(o["createdAt"].replace("Z", "+00:00")).astimezone(dt.timezone(dt.timedelta(hours=13))).date()
    EV["Shopify " + o["name"]] = (d, float(o["currentSubtotalPriceSet"]["shopMoney"]["amount"]), ((o["purchasingEntity"] or {}).get("company") or {}).get("name"))

fails = []
def check(cond, msg):
    if not cond: fails.append(msg)

FROM, TO = dt.date(2026, 4, 1), dt.date(2026, 10, 14)
raw = collections.defaultdict(lambda: [0, 0.0, 0, 0.0])
for h in H:
    d = pd(h["INVOICEDATE"])
    if FROM <= d <= TO:
        c = h["SALESPERSON"].split("-")[0]; r = raw[c]
        if h["INVOICEORCREDIT"] == "Invoice": r[0] += 1; r[1] += h["INVOICENETTAMOUNT"]
        else: r[2] += 1; r[3] += h["INVOICENETTAMOUNT"]

used_orders = collections.Counter(); used_inv = collections.Counter(); sampled = []
login_stores = collections.defaultdict(set)
for f in sorted(glob.glob(OUT + "/*.xlsx")):
    code = [x for x in os.path.basename(f).split("_") if x.isdigit()][0]
    wb = openpyxl.load_workbook(f)
    check("Start Here" not in wb.sheetnames, f"{code}: Start Here still present")
    ws = wb["Summary"]
    cells = {r[0]: r for r in ws.iter_rows(min_row=1, max_row=40, values_only=True) if r[0]}
    g = cells["Total sales"][2]; cr = cells["Credit notes (money given back)"][2]
    e = raw[code]
    check(abs(g - e[1]) < 0.01, f"{code}: sales {g} != ostendo {e[1]}")
    check(abs(cr + e[3]) < 0.01, f"{code}: credits {cr} != ostendo {-e[3]}")
    rows = [r for r in wb["All Invoices"].iter_rows(min_row=5, values_only=True) if r[1]]
    inv = [r for r in rows if r[2] == "Invoice"]; cn = [r for r in rows if r[2] == "Credit note"]
    check(len(inv) == e[0] and len(cn) == e[2], f"{code}: counts {len(inv)}/{len(cn)} != {e[0]}/{e[2]}")
    check(abs(sum(r[6] for r in inv) - e[1]) < 0.01, f"{code}: invoice lines do not sum to ostendo")
    # every line equals raw Ostendo
    for r in rows:
        h = RAW.get(r[1]);
        if not h: fails.append(f"{code}: invoice {r[1]} not in Ostendo"); continue
        check(abs(h["INVOICENETTAMOUNT"] - r[6]) < 0.005 and h["SALESPERSON"].split("-")[0] == code and pd(h["INVOICEDATE"]) == r[0].date(), f"{code}: line {r[1]} differs from Ostendo")
        check(h["DELIVERYCUSTOMER"] == r[4], f"{code}: store differs {r[1]}")
    chn = collections.Counter(r[7] for r in inv)
    check(sum(chn.values()) == len(inv) and set(chn) <= {"Online", "Rep or phone", "Foodstuffs head office"}, f"{code}: channel labels")
    # online proof audit
    onl = [r for r in wb["Online Orders"].iter_rows(min_row=5, values_only=True) if r[1] and r[1] != "Total" and r[0] != "Total"]
    check(len(onl) == chn["Online"], f"{code}: online rows {len(onl)} != channel counts")
    invmap = {r[1]: r for r in inv}
    for r in onl:
        used_inv[r[1]] += 1
        m = re.match(r"^(Old site \S+|Shopify \S+): (.*)$", r[5])
        if not m:
            check("twice" in r[5], f"{code}: unprovable online row {r[1]}"); continue
        ref = m.group(1); used_orders[ref] += 1
        ev = EV.get(ref)
        if not ev: fails.append(f"{code}: order {ref} not found in source data"); continue
        d, a, u = ev; ir = invmap[r[1]]; days = (r[0].date() - d).days; amt = r[3]
        if "same amount" in r[5]:
            check(-1 <= days <= 14 and abs(amt - a) <= max(0.05, 0.002 * a), f"{code}: A-proof fails {r[1]} vs {ref} (days {days}, {amt} vs {a})")
        else:
            check(0 <= days <= 10 and 0.5 <= amt / a <= 1.6, f"{code}: B-proof fails {r[1]} vs {ref} (days {days}, {amt} vs {a})")
        if ref.startswith("Old site"): login_stores[u].add(r[2])
    check(abs(sum(r[3] for r in onl) - sum(r[6] for r in inv if r[7] == "Online")) < 0.01, f"{code}: online sheet total")
    # region audit
    br = wb["By Region"]
    reg_rows = [r for r in br.iter_rows(min_row=5, max_row=30, values_only=True) if r[0] and r[0] != "All regions" and isinstance(r[4], (int, float)) and r[3] and r[2] is not None and not str(r[0]).startswith("Not placed:")]
    allr = [r for r in br.iter_rows(min_row=5, max_row=30, values_only=True) if r[0] == "All regions"][0]
    check(abs(sum(r[4] for r in reg_rows) - e[1]) < 0.01 and abs(allr[4] - e[1]) < 0.01, f"{code}: regions do not sum to ostendo")
    check(sum(r[3] for r in reg_rows) == e[0], f"{code}: region invoice counts")
    for r in reg_rows:
        check(abs(r[4] - (r[5] + r[6] + r[7])) < 0.01, f"{code}: region {r[0]} channel parts do not add up")
    sampled += [r[1] for r in rows]

check(all(v == 1 for v in used_orders.values()), "an online order was used for more than one invoice: " + str([k for k, v in used_orders.items() if v > 1][:5]))
check(all(v == 1 for v in used_inv.values()), "an invoice appears twice in online sheets")
multi = {u: s for u, s in login_stores.items() if len(s) > 4}
print("old-site logins mapped to more than 4 stores (review):", {u: len(s) for u, s in multi.items()})

# live spot check straight from Ostendo
random.seed(15)
pick = random.sample(sorted(set(sampled)), 25)
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
base_url, key = os.environ["OSTENDO_BASE_URL"], os.environ["OSTENDO_API_KEY"]
q = "SELECT INVOICENUMBER,INVOICEDATE,INVOICEORCREDIT,SALESPERSON,DELIVERYCUSTOMER,INVOICENETTAMOUNT FROM SALESINVOICEHEADER WHERE INVOICENUMBER IN (" + ",".join("'" + p + "'" for p in pick) + ")"
live = json.loads(urllib.request.urlopen(urllib.request.Request(f"{base_url}/sqlquery?apikey={key}&format=json", data=q.encode(), headers={"Content-Type": "text/plain", "User-Agent": "curl/8.4.0"}), context=ctx).read())
lv = {x["INVOICENUMBER"]: x for x in live}
ok_live = 0
for p in pick:
    x, h = lv.get(p), RAW[p]
    if x and abs(x["INVOICENETTAMOUNT"] - h["INVOICENETTAMOUNT"]) < 0.005 and x["SALESPERSON"] == h["SALESPERSON"] and x["INVOICEDATE"] == h["INVOICEDATE"] and x["DELIVERYCUSTOMER"] == h["DELIVERYCUSTOMER"]: ok_live += 1
    else: fails.append(f"live Ostendo differs for {p}")
print(f"live Ostendo spot check: {ok_live}/{len(pick)} invoices identical")
print("online source orders used:", len(used_orders), "| invoices counted online:", len(used_inv))
print("FAILURES:", len(fails))
for x in fails[:30]: print("  ", x)
