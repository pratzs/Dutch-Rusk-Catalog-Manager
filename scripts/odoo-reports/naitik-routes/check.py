import xmlrpc.client, ssl, json, sys, os, collections
env={}
for l in open(os.path.expanduser('~/.odoo-worthy.env')):
    if '=' in l and not l.startswith('#'): k,v=l.strip().split('=',1); env[k]=v.strip().strip('"')
ctx=ssl._create_unverified_context()
uid=xmlrpc.client.ServerProxy(env['ODOO_URL']+'/xmlrpc/2/common',context=ctx).authenticate(env['ODOO_DB'],env['ODOO_USER'],env['ODOO_PASS'],{})
mo=xmlrpc.client.ServerProxy(env['ODOO_URL']+'/xmlrpc/2/object',context=ctx,allow_none=True)
def x(model,method,*a,**k): return mo.execute_kw(env['ODOO_DB'],uid,env['ODOO_PASS'],model,method,list(a),k)
g=x('account.move.line','read_group',[['move_id.company_id','=',4],['move_id.move_type','in',['out_invoice','out_refund']],['move_id.state','=','posted'],['move_id.invoice_date','>=','2026-04-01'],['move_id.invoice_date','<=','2026-10-22'],['move_id.invoice_user_id','=',45],['display_type','=','product'],['product_id','!=',False]],['balance:sum'],['company_id'],lazy=False,context={'allowed_company_ids':[4]})
print('Odoo read_group product net for Naitik:', [round(-r['balance'],2) for r in g])
