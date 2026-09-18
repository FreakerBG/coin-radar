import {z} from 'zod';
import {getChatGPTUser} from '@/app/chatgpt-auth';
import {reportFailure} from '@/lib/diagnostics';
import {db,getConfig,getPositions,sameOrigin} from '@/lib/research-db';
import {readJsonObject} from '@/lib/request-body';
import type {Position} from '@/lib/advisor';
const configSchema=z.object({bankroll:z.number().finite().min(0).max(1e8),riskPct:z.number().finite().min(.1).max(100),maxAllocationPct:z.number().finite().min(.1).max(100),takeProfitPct:z.number().finite().min(1).max(10000),stopPct:z.number().finite().min(1).max(99),trailingPct:z.number().finite().min(1).max(99),liquidityDropPct:z.number().finite().min(1).max(99),xDailyRequests:z.number().int().min(0).max(100)});
export async function GET(){const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in to load your research account.'},{status:401});try{const database=db();const [config,positions,events]=await Promise.all([getConfig(user.userId),getPositions(user.userId),database.prepare('SELECT data FROM research_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').bind(user.userId).all<{data:string}>()]);return Response.json({config,positions,events:events.results.map(r=>JSON.parse(r.data)),monitoring:'browser_open_only'},{headers:{'Cache-Control':'no-store'}});}catch(e){reportFailure('portfolio','load',e);return Response.json({error:'Research storage unavailable. Your saved positions have not been changed.'},{status:503});}}
export async function POST(request:Request){const user=await getChatGPTUser();if(!user)return Response.json({error:'Sign in required.'},{status:401});if(!sameOrigin(request))return Response.json({error:'Same-origin request required.'},{status:403});
 const b:any=await readJsonObject(request);if(!b)return Response.json({error:'Invalid JSON body.'},{status:400});try{
 if(b.action==='config'){const config=configSchema.parse(b.config);await db().prepare('INSERT INTO research_accounts (user_id, config) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET config = excluded.config, revision = research_accounts.revision + 1').bind(user.userId,JSON.stringify(config)).run();return Response.json({ok:true});}
 if(b.action==='close'){const id=z.string().uuid().parse(b.id);const result=await db().prepare('UPDATE research_positions SET closed_at = ?, revision = revision + 1 WHERE id = ? AND user_id = ? AND closed_at IS NULL').bind(new Date().toISOString(),id,user.userId).run();return Response.json({ok:!!result.meta.changes});}
 if(b.action==='position'){
  const input=z.object({id:z.string().uuid(),address:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),pair:z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),symbol:z.string().min(1).max(40),entryPrice:z.number().finite().positive().max(1e9),amount:z.number().finite().min(.01).max(1e8),entryLiquidity:z.number().finite().nonnegative().nullable()}).parse(b.position);
  const config=await getConfig(user.userId);
  const p:Position={...input,quantity:input.amount/input.entryPrice,peakPrice:input.entryPrice,takeProfitPct:config.takeProfitPct,stopPct:config.stopPct,trailingPct:config.trailingPct,liquidityDropPct:config.liquidityDropPct,openedAt:new Date().toISOString(),closedAt:null,lastPrice:null,lastCheckedAt:null};
  if(!Number.isFinite(p.quantity))return Response.json({error:'Invalid position quantity.'},{status:400});
  // One statement applies the open-position limit atomically; an existing ID is then an idempotent retry.
  const inserted=await db().prepare('INSERT OR IGNORE INTO research_positions (id, user_id, data) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM research_positions WHERE user_id = ? AND closed_at IS NULL) < 30').bind(p.id,user.userId,JSON.stringify(p),user.userId).run();if(inserted.meta.changes)return Response.json({ok:true});
  const existing=await db().prepare('SELECT user_id FROM research_positions WHERE id = ?').bind(p.id).first<{user_id:string}>();if(existing?.user_id===user.userId)return Response.json({ok:true});
  if(existing)return Response.json({error:'This position ID is unavailable. Reload and record the position again.'},{status:409});
  return Response.json({error:'Maximum 30 open positions.'},{status:400});
 }
 return Response.json({error:'Unknown action.'},{status:400});
 }catch(e){if(!(e instanceof z.ZodError))reportFailure('portfolio','save',e);return Response.json({error:e instanceof z.ZodError?'Check the amounts and alert percentages.':'Could not save. Your input is still available; try again.'},{status:e instanceof z.ZodError?400:503});}}
