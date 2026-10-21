import xmlrpc.client, ssl, json, sys, os
env={}
for l in open(os.path.expanduser('~/.odoo-worthy.env')):
    if '=' in l: k,v=l.strip().split('=',1); env[k]=v.strip().strip('"')
ctx=ssl._create_unverified_context()
com=xmlrpc.client.ServerProxy(env['ODOO_URL']+'/xmlrpc/2/common',context=ctx)
uid=com.authenticate(env['ODOO_DB'],env['ODOO_USER'],env['ODOO_PASS'],{})
mo=xmlrpc.client.ServerProxy(env['ODOO_URL']+'/xmlrpc/2/object',context=ctx,allow_none=True)
def x(model,method,*a,**k): return mo.execute_kw(env['ODOO_DB'],uid,env['ODOO_PASS'],model,method,list(a),k)
out=sys.argv[1]
users=x('res.users','search_read',[['name','ilike','naitik']],fields=['id','name'],context={'active_test':False})
print(users)
uidn=users[0]['id']
moves=x('account.move','search_read',[['company_id','=',4],['move_type','in',['out_invoice','out_refund']],['state','=','posted'],['invoice_date','>=','2026-04-01'],['invoice_date','<=','2026-10-22'],['invoice_user_id','=',uidn]],
        fields=['name','move_type','invoice_date','invoice_origin','partner_id','partner_shipping_id','amount_untaxed_signed','invoice_user_id'],context={'allowed_company_ids':[4]})
ids=[m['id'] for m in moves]
lines=[]
for i in range(0,len(ids),200):
    lines+=x('account.move.line','search_read',[['move_id','in',ids[i:i+200]],['display_type','=','product']],fields=['move_id','product_id','balance','account_id','name'],context={'allowed_company_ids':[4]})
origins=sorted({m['invoice_origin'] for m in moves if m['invoice_origin']})
sos=[]
for i in range(0,len(origins),200):
    sos+=x('sale.order','search_read',[['name','in',origins[i:i+200]],['company_id','=',4]],fields=['name','date_order','user_id','partner_shipping_id','create_date','website_id','team_id'],context={'allowed_company_ids':[4]})
json.dump({'user':users[0],'moves':moves,'lines':lines,'sos':sos},open(out,'w'),default=str)
print(len(moves),'moves',len(lines),'lines',len(sos),'sale orders of',len(origins),'origins')
