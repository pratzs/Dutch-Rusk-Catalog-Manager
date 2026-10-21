import xmlrpc.client, ssl, json, sys, os
env={}
for l in open(os.path.expanduser('~/.odoo-worthy.env')):
    if '=' in l and not l.startswith('#'): k,v=l.strip().split('=',1); env[k]=v.strip().strip('"')
ctx=ssl._create_unverified_context()
uid=xmlrpc.client.ServerProxy(env['ODOO_URL']+'/xmlrpc/2/common',context=ctx).authenticate(env['ODOO_DB'],env['ODOO_USER'],env['ODOO_PASS'],{})
mo=xmlrpc.client.ServerProxy(env['ODOO_URL']+'/xmlrpc/2/object',context=ctx,allow_none=True)
def x(model,method,*a,**k): return mo.execute_kw(env['ODOO_DB'],uid,env['ODOO_PASS'],model,method,list(a),k)
D=json.load(open(sys.argv[1]))
pids=sorted({m['partner_shipping_id'][0] for m in D['moves']}|{m['partner_id'][0] for m in D['moves']})
ps=x('res.partner','read',pids,fields=['name','category_id','city','commercial_partner_id','user_id'],context={'active_test':False})
cats={c['id']:c['name'] for c in x('res.partner.category','search_read',[],fields=['name'])}
for p in ps: p['tags']=[cats.get(c,c) for c in p['category_id']]
cp=sorted({p['commercial_partner_id'][0] for p in ps}-set(pids))
ps2=x('res.partner','read',cp,fields=['name','category_id','city','commercial_partner_id'],context={'active_test':False}) if cp else []
for p in ps2: p['tags']=[cats.get(c,c) for c in p['category_id']]
json.dump({'partners':ps+ps2},open(sys.argv[2],'w'),default=str); print(len(ps),len(ps2))
