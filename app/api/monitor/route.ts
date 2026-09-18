import {getChatGPTUser} from '@/app/chatgpt-auth';
import {reportFailure} from '@/lib/diagnostics';
import {db,getPositions,acquireLock,releaseLock,sameOrigin} from '@/lib/research-db';
import {evaluatePosition} from '@/lib/advisor';
import {fetchJson,numeric} from '@/lib/market';
export async function POST(request:Request){const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in required.'},{status:401});if(!sameOrigin(request))return Response.json({error:'Same-origin request required.'},{status:403});let lock:string|null=null;const lockId='monitor:'+user.userId;
 try {lock=await acquireLock(lockId);if(!lock)return Response.json({status:'busy',newEvents:[]});const positions=await getPositions(user.userId);if(!positions.length)return Response.json({status:'idle',newEvents:[],asOf:new Date().toISOString()});
 let pools:any[]=[];let providerAvailable=true;
 try{const r=await fetchJson('https://api.dexscreener.com/latest/dex/pairs/solana/'+[...new Set(positions.map(p=>p.pair))].join(','),10000);pools=r.pairs||[];}catch(e){providerAvailable=false;reportFailure('monitor','provider',e,'warn');}
 const now=new Date().toISOString(),newEvents:any[]=[];
 for(const p of positions){const pool=pools.find(q=>q.chainId==='solana'&&q.pairAddress===p.pair&&q.baseToken?.address===p.address);const price=pool?.priceUsd?numeric(Number(pool.priceUsd)):null;const liquidity=numeric(pool?.liquidity?.usd);const result=evaluatePosition(p,price,liquidity);const updated={...p,peakPrice:result.peak,lastPrice:price,lastCheckedAt:now};
 const positionUpdate=await db().prepare('UPDATE research_positions SET data = ?, revision = revision + 1 WHERE id = ? AND user_id = ? AND closed_at IS NULL').bind(JSON.stringify(updated),p.id,user.userId).run();if(!positionUpdate.meta.changes)continue;
 for(const e of result.events){const id=p.id+':'+e.kind;const event={...e,id,positionId:p.id,address:p.address,symbol:p.symbol,time:now,price};const inserted=await db().prepare('INSERT OR IGNORE INTO research_events (id, user_id, position_id, kind, data, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM research_positions WHERE id = ? AND user_id = ? AND closed_at IS NULL)').bind(id,user.userId,p.id,e.kind,JSON.stringify(event),now,p.id,user.userId).run();if(inserted.meta.changes)newEvents.push(event);}
 }
 return Response.json({status:providerAvailable?'checked':'provider_unavailable',asOf:now,newEvents,monitoring:'browser_open_only',message:'Checks use provider snapshots, not executable quotes. Delivery and exit price are not guaranteed.'},{headers:{'Cache-Control':'no-store'}});
 }catch(e){reportFailure('monitor','scan',e);return Response.json({error:'Position monitoring failed. Check positions directly in Phantom.'},{status:503});}finally{if(lock)await releaseLock(lockId,lock).catch(e=>reportFailure('monitor','release-lock',e));}}
