import {getChatGPTUser} from '@/app/chatgpt-auth';
import {reportFailure} from '@/lib/diagnostics';
import {getConfig,getPositions} from '@/lib/research-db';
import {sizePosition} from '@/lib/advisor';
import {fetchJson,normalize,type Coin} from '@/lib/market';
export async function GET(request:Request){const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in required.'},{status:401});const address=new URL(request.url).searchParams.get('address')||'';if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))return Response.json({error:'Invalid contract address.'},{status:400});
 // Optional exact pool (a Goldmine handoff). When given, only that pool's evidence is used; another pool of the
 // same mint is never substituted, because the recorded position will be monitored on this one.
 const pair=new URL(request.url).searchParams.get('pair');if(pair!==null&&!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pair))return Response.json({error:'Invalid pool address.'},{status:400});
try{const [config,positions,pools]=await Promise.all([getConfig(user.userId),getPositions(user.userId),fetchJson('https://api.dexscreener.com/tokens/v1/solana/'+address)]);const coins:Coin[]=pools.map((p:any)=>normalize(p)).filter((c:Coin|null)=>c?.address===address&&(pair===null||c.pair===pair));const coin=coins.sort((a,b)=>(b.liquidity||0)-(a.liquidity||0))[0]||null;return Response.json({coin,allocation:sizePosition(config,positions.reduce((n,p)=>n+p.amount,0),coin,false),safety:'unverified',socialInfluence:'excluded',asOf:new Date().toISOString()},{headers:{'Cache-Control':'no-store'}});}catch(e){reportFailure('advisor','evidence',e);return Response.json({error:'Evidence unavailable. No allocation suggested.'},{status:503});}}
