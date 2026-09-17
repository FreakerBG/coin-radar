import {reportFailure} from '@/lib/diagnostics';
import {safeUrl} from '@/lib/market';
let cached:{at:number;items:unknown[]}|undefined;
function clean(s:string){return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');}
export async function GET(){try{
 if(cached&&Date.now()-cached.at<300000)return Response.json({items:cached.items,asOf:new Date(cached.at).toISOString()});
 const r=await fetch('https://www.coindesk.com/arc/outboundfeeds/rss/',{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('CoinDesk returned '+r.status);
 const xml=await r.text();const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0,8).map(m=>{const get=(tag:string)=>clean(m[1].match(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+tag+'>'))?.[1]||'');return {title:get('title'),url:safeUrl(get('link')),date:get('pubDate'),source:'CoinDesk'};}).filter(x=>x.url&&x.title);
 if(!items.length)throw Error('CoinDesk feed had no usable items');cached={at:Date.now(),items};return Response.json({items,asOf:new Date(cached.at).toISOString()});
 }catch(e){reportFailure('news','provider',e,'warn');return Response.json({items:[],error:'News feed is temporarily unavailable.'},{status:502});}}
