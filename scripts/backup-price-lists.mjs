// Snapshot EVERY catalog's fixed prices, compare-at and quantity breaks to one JSON file.
//
//   node scripts/backup-price-lists.mjs C:/Users/PrathamJani/dutch-rusk-backups/pre_<what>_<date>.json
//
// Take one before any bulk price change and one after. Keep them OUTSIDE the repo:
// this repo is public and the file is wholesale pricing. It re-reads the file and
// checks the counts before it says it is done.
import { PrismaClient } from "@prisma/client"; import fs from "node:fs"; import crypto from "node:crypto";
const OUT=process.argv[2]; if(!OUT){console.error("usage: node scripts/backup-price-lists.mjs <output.json>");process.exit(1);}
const p=new PrismaClient(); const s=await p.session.findFirst({where:{isOnline:false,accessToken:{not:""}},orderBy:{id:"desc"}});
const gql=async(q,v)=>{for(let a=0;a<6;a++){const r=await fetch(`https://${s.shop}/admin/api/2026-07/graphql.json`,{method:"POST",headers:{"Content-Type":"application/json","X-Shopify-Access-Token":s.accessToken},body:JSON.stringify({query:q,variables:v})});const j=await r.json();if(j.errors?.some(e=>e.extensions?.code==="THROTTLED")){await new Promise(r=>setTimeout(r,2500*(a+1)));continue;}if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,400));return j.data;}throw new Error("throttled");};
const lists=[];let after=null;
do{const d=await gql(`query($a:String){ priceLists(first:50, after:$a){ pageInfo{hasNextPage endCursor} nodes{ id name currency parent{adjustment{type value}} } } }`,{a:after});lists.push(...d.priceLists.nodes);after=d.priceLists.pageInfo.hasNextPage?d.priceLists.pageInfo.endCursor:null;}while(after);
const snap={takenAt:new Date().toISOString(),shop:s.shop,lists:[]};
for(const pl of lists){ const fixed=[],breaks=[]; let a=null;
 do{const d=await gql(`query($id:ID!,$a:String){ priceList(id:$id){ prices(first:250, after:$a, originType:FIXED){ pageInfo{hasNextPage endCursor} nodes{ price{amount currencyCode} compareAtPrice{amount currencyCode} variant{ id sku price product{title} title } quantityPriceBreaks(first:10){ nodes{ minimumQuantity price{amount} } } } } } }`,{id:pl.id,a});
  const pg=d.priceList.prices; pg.nodes.forEach(x=>{ for(const b of x.quantityPriceBreaks.nodes) breaks.push({variantId:x.variant.id,minimumQuantity:b.minimumQuantity,price:b.price.amount}); fixed.push({variantId:x.variant.id,sku:x.variant.sku,product:x.variant.product.title,variant:x.variant.title,retailAtBackup:x.variant.price,price:x.price.amount,compareAt:x.compareAtPrice?.amount??null}); }); a=pg.pageInfo.hasNextPage?pg.pageInfo.endCursor:null;}while(a);
  snap.lists.push({id:pl.id,name:pl.name,currency:pl.currency,parentAdjustment:pl.parent?.adjustment??null,fixedCount:fixed.length,breakCount:breaks.length,fixed,breaks}); console.log(pl.name.replace(/ - [0-9a-f-]{36}$/,"").padEnd(26),"fixed",fixed.length,"breaks",breaks.length); }
const txt=JSON.stringify(snap); fs.writeFileSync(OUT,txt);
const back=JSON.parse(fs.readFileSync(OUT,"utf8")); const ok=back.lists.every((l,i)=>l.fixed.length===snap.lists[i].fixedCount&&l.breaks.length===snap.lists[i].breakCount);
console.log("file:",OUT,"| bytes",fs.statSync(OUT).size,"| re-read counts match:",ok,"| sha256",crypto.createHash("sha256").update(txt).digest("hex").slice(0,16));
await p.$disconnect();
