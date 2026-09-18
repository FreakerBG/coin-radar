import {reportFailure} from '@/lib/diagnostics';
import {discoverSolanaPairs,fetchJson,normalize,type Coin} from '@/lib/market';
export async function GET(request:Request){
 const url=new URL(request.url),query=(url.searchParams.get('q')||'').trim().slice(0,100);
 const addresses=(url.searchParams.get('addresses')||'').split(',').filter(x=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x)).slice(0,30);
 const warnings:string[]=[];let pairs:any[]=[];let boosted=new Set<string>();
 try {
  if(addresses.length){pairs=await fetchJson('https://api.dexscreener.com/tokens/v1/solana/'+addresses.join(','));}
  else if(query){const r=await fetchJson('https://api.dexscreener.com/latest/dex/search?q='+encodeURIComponent(query));pairs=r.pairs||[];}
  else {const discovered=await discoverSolanaPairs();pairs=discovered.pairs;boosted=discovered.boosted;warnings.push(...discovered.warnings);}
  if(!Array.isArray(pairs))throw new Error('Unexpected provider response');
  const coins=new Map<string,Coin>();
  for(const p of pairs){const c=normalize(p,boosted.has(p.baseToken?.address));if(c&&(!addresses.length||addresses.includes(c.address))&&(!coins.has(c.address)||(c.liquidity||0)>(coins.get(c.address)!.liquidity||0)))coins.set(c.address,c);}
  return Response.json({coins:[...coins.values()].sort((a,b)=>b.score-a.score),asOf:new Date().toISOString(),source:'DEX Screener',warnings,coverage:'Latest profiles and promoted tokens; up to 30 Solana tokens. Highest-liquidity returned pool per token. Not a whole-market ranking.',cacheSeconds:60},{headers:{'Cache-Control':'private, max-age=30'}});
 }catch(e){reportFailure('market','provider',e,'warn');return Response.json({coins:[],asOf:null,error:'Market provider unavailable. Retry shortly; no trading signals are being generated.'},{status:502});}
}
