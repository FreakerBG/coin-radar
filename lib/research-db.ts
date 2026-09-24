import {env} from 'cloudflare:workers';
import {defaultConfig,type RiskConfig,type Position} from './advisor';
export function db(){if(!env.DB)throw Error('Research storage is unavailable.');return env.DB;}
export async function getConfig(userId:string):Promise<RiskConfig>{const row=await db().prepare('SELECT config FROM research_accounts WHERE user_id = ?').bind(userId).first<{config:string}>();return row?{...defaultConfig,...JSON.parse(row.config)}:{...defaultConfig};}
export async function getPositions(userId:string):Promise<Position[]>{const rows=await db().prepare('SELECT data FROM research_positions WHERE user_id = ? AND closed_at IS NULL').bind(userId).all<{data:string}>();return rows.results.map(r=>JSON.parse(r.data));}
// A lock is a lease, not a mutex: a row with an expiry. acquireLock() takes it only when no unexpired
// row exists, and releaseLock() deletes only a row this owner still holds. What that guarantees is
// bounded, and worth stating exactly, because it is easy to overstate:
//   - Two callers can never hold the SAME lease at the same time.
//   - A holder that dies without releasing blocks others only until `ttlMs` elapses.
//   - It does NOT provide exactly-once execution. If a holder runs past `ttlMs` its lease expires
//     underneath it, a second caller legitimately acquires, and the two run concurrently. `ttlMs`
//     must therefore exceed the worst-case runtime of the work it guards, or the lock silently stops
//     doing its job - which is why lib/goldmine/scan.ts passes its own, much longer lease.
// The default matches the short, request-shaped work (monitor:<user>) that has always used it.
export const DEFAULT_LOCK_TTL_MS=60000;
export async function acquireLock(id:string,ttlMs:number=DEFAULT_LOCK_TTL_MS){const owner=crypto.randomUUID(),now=Date.now();const row=await db().prepare('INSERT INTO research_locks (id, owner, expires) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires = excluded.expires WHERE research_locks.expires < ? RETURNING owner').bind(id,owner,now+ttlMs,now).first<{owner:string}>();return row?.owner===owner?owner:null;}
export async function releaseLock(id:string,owner:string){await db().prepare('DELETE FROM research_locks WHERE id = ? AND owner = ?').bind(id,owner).run();}
export function sameOrigin(request:Request){const origin=request.headers.get('origin');return !!origin&&origin===new URL(request.url).origin;}
