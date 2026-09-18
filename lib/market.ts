export type Coin = { address:string; name:string; symbol:string; price:number|null; change5m:number|null; change1h:number|null; change24h:number|null; liquidity:number|null; volume:number|null; marketCap:number|null; buys:number|null; sells:number|null; ageHours:number|null; pair:string; boosted:boolean; score:number; verdict:string; reasons:string[]; risks:string[]; links:{label:string;url:string}[] };
export const numeric=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
export function safeUrl(value:unknown):string|null {try {const u=new URL(String(value));return u.protocol==='https:'?u.href:null;}catch{return null;}}
export function assess(c:Pick<Coin,'liquidity'|'volume'|'change1h'|'change24h'|'buys'|'sells'|'ageHours'>){
 const reasons:string[]=[],risks:string[]=[]; let score=0;
 if(c.liquidity==null) risks.push('Liquidity is unavailable.'); else if(c.liquidity<25000) risks.push('Thin liquidity below $25k: exits may move the price sharply.'); else {score+=c.liquidity>=100000?25:15;reasons.push('At least $25k of reported pool liquidity.');}
 if(c.volume!=null&&c.volume>=100000){score+=20;reasons.push('At least $100k in reported 24h volume.');}
 if(c.change1h!=null&&c.change1h>0){score+=Math.min(20,c.change1h);reasons.push('Positive price momentum over the last hour.');}
 if(c.buys!=null&&c.sells!=null&&c.buys+c.sells>=20&&c.buys>c.sells){score+=20;reasons.push('More buy transactions than sells in the last hour; these are not unique traders.');}
 if(c.ageHours==null)risks.push('Pool age is unavailable.');else if(c.ageHours<24)risks.push('Pool is less than 24 hours old.');else {score+=15;}
 if(c.change1h!=null&&c.change1h>50)risks.push('More than 50% growth in one hour: elevated reversal risk.');
 if(c.change24h!=null&&c.change24h<-30)risks.push('Price has fallen more than 30% in 24 hours.');
 if(c.liquidity&&c.volume!=null&&c.volume/c.liquidity>30)risks.push('Very high volume relative to liquidity; activity may be distorted.');
 const displayedScore=Math.floor(score);
 return {score:displayedScore,verdict:risks.length?'High caution':displayedScore>=65?'Research candidate':'Watch',reasons,risks};
}
const cache=new Map<string,{expires:number;value:unknown}>();
export async function fetchJson(url:string,ttl=60000,headers?:Record<string,string>):Promise<any>{
 const old=cache.get(url);if(old&&old.expires>Date.now())return old.value;
 const r=await fetch(url,{headers:{Accept:'application/json',...headers},signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw new Error(`Provider returned ${r.status}`);const value=await r.json();
 if(cache.size>100)cache.clear();cache.set(url,{value,expires:Date.now()+ttl});return value;
}
// Discovery shared by GET /api/market (no query) and POST /api/goldmine: the latest DEX Screener token
// profiles and top boosts, up to 30 Solana tokens, and every pool the provider returns for them.
type Listing={chainId?:unknown;tokenAddress?:unknown};
export async function discoverSolanaPairs():Promise<{pairs:unknown[];boosted:Set<string>;warnings:string[]}>{
 const warnings:string[]=[];
 const sources=await Promise.allSettled([fetchJson('https://api.dexscreener.com/token-profiles/latest/v1'),fetchJson('https://api.dexscreener.com/token-boosts/top/v1')]);
 const listings=(source:PromiseSettledResult<unknown>):Listing[]=>source.status==='fulfilled'&&Array.isArray(source.value)?source.value:[];
 const profiles=listings(sources[0]),boosts=listings(sources[1]);
 if(sources.some(s=>s.status==='rejected'))warnings.push('One discovery feed is unavailable. Coverage is reduced.');
 const boosted=new Set(boosts.filter(p=>p?.chainId==='solana').map(p=>String(p.tokenAddress)));
 const addrs=[...new Set([...profiles,...boosts].filter(p=>p?.chainId==='solana'&&typeof p.tokenAddress==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(p.tokenAddress)).map(p=>p.tokenAddress as string))].slice(0,30);
 if(!addrs.length)throw new Error('Discovery feeds returned no Solana tokens.');
 const pairs=await fetchJson('https://api.dexscreener.com/tokens/v1/solana/'+addrs.join(','));
 if(!Array.isArray(pairs))throw new Error('Unexpected provider response');
 return {pairs,boosted,warnings};
}
export function normalize(p:any,boosted=false):Coin|null{
 const address=p.baseToken?.address;if(p.chainId!=='solana'||!address||!p.pairAddress)return null;
 const c={address,name:String(p.baseToken.name||'Unknown'),symbol:String(p.baseToken.symbol||'?'),price:numeric(Number(p.priceUsd))&&Number(p.priceUsd)>0?Number(p.priceUsd):null,change5m:numeric(p.priceChange?.m5),change1h:numeric(p.priceChange?.h1),change24h:numeric(p.priceChange?.h24),liquidity:numeric(p.liquidity?.usd),volume:numeric(p.volume?.h24),marketCap:numeric(p.marketCap),buys:numeric(p.txns?.h1?.buys),sells:numeric(p.txns?.h1?.sells),ageHours:p.pairCreatedAt?Math.max(0,(Date.now()-p.pairCreatedAt)/3600000):null,pair:String(p.pairAddress),boosted:boosted||Number(p.boosts?.active)>0,links:[...(p.info?.websites||[]).map((x:any)=>({label:'Project website · unverified',url:safeUrl(x.url)})),...(p.info?.socials||[]).map((x:any)=>({label:`${x.type||'Social'} · project supplied`,url:safeUrl(x.url)}))].filter((x:any)=>x.url)};
 return {...c,...assess(c)};
}
