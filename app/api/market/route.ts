import {reportFailure} from '@/lib/diagnostics';
import {fetchJson,normalize,type Coin} from '@/lib/market';
export async function GET(request:Request){
 const url=new URL(request.url),query=(url.searchParams.get('q')||'').trim().slice(0,100);
 const addresses=(url.searchParams.get('addresses')||'').split(',').filter(x=>/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x)).slice(0,30);
 const warnings:string[]=[];let pairs:any[]=[];let boosted=new Set<string>();
 try {
  if(addresses.length){pairs=await fetchJson('https://api.dexscreener.com/tokens/v1/solana/'+addresses.join(','));}
  else if(query){const r=await fetchJson('https://api.dexscreener.com/latest/dex/search?q='+encodeURIComponent(query));pairs=r.pairs||[];}
  else {
   const sources=await Promise.allSettled([fetchJson('https://api.dexscreener.com/token-profiles/latest/v1'),fetchJson('https://api.dexscreener.com/token-boosts/top/v1')]);
   const profiles=sources[0].status==='fulfilled'&&Array.isArray(sources[0].value)?sources[0].value:[];
   const boosts=sources[1].status==='fulfilled'&&Array.isArray(sources[1].value)?sources[1].value:[];
   if(sources.some(s=>s.status==='rejected'))warnings.push('One discovery feed is unavailable. Coverage is reduced.');
   boosted=new Set(boosts.filter((p:any)=>p.chainId==='solana').map((p:any)=>p.tokenAddress));
   const addrs=[...new Set([...profiles,...boosts].filter((p:any)=>p.chainId==='solana'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.tokenAddress)).map((p:any)=>p.tokenAddress))].slice(0,30);
   if(!addrs.length)throw new Error('Discovery feeds returned no Solana tokens.');
   pairs=await fetchJson('https://api.dexscreener.com/tokens/v1/solana/'+addrs.join(','));
  }
  if(!Array.isArray(pairs))throw new Error('Unexpected provider response');
  const coins=new Map<string,Coin>();
  for(const p of pairs){const c=normalize(p,boosted.has(p.baseToken?.address));if(c&&(!addresses.length||addresses.includes(c.address))&&(!coins.has(c.address)||(c.liquidity||0)>(coins.get(c.address)!.liquidity||0)))coins.set(c.address,c);}
  return Response.json({coins:[...coins.values()].sort((a,b)=>b.score-a.score),asOf:new Date().toISOString(),source:'DEX Screener',warnings,coverage:'Latest profiles and promoted tokens; up to 30 Solana tokens. Highest-liquidity returned pool per token. Not a whole-market ranking.',cacheSeconds:60},{headers:{'Cache-Control':'private, max-age=30'}});
 }catch(e){reportFailure('market','provider',e,'warn');return Response.json({coins:[],asOf:null,error:'Market provider unavailable. Retry shortly; no trading signals are being generated.'},{status:502});}
}
