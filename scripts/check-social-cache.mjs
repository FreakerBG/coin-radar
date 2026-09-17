// Run with Node >=22.13: node --experimental-strip-types --test scripts/check-social-cache.mjs
// Exercise the actual route handlers; replace only external runtime dependencies.
import assert from 'node:assert/strict';
import {register} from 'node:module';
import {test, beforeEach} from 'node:test';

const root = new URL('../', import.meta.url).href;
const mocks = {
  'cloudflare:workers': 'export const env = globalThis.socialTest.env;',
  '@/app/chatgpt-auth': 'export async function getChatGPTUser(){return globalThis.socialTest.user;}',
  '@/lib/research-db': `export const db=()=>globalThis.socialTest.db;
    export const getConfig=async id=>globalThis.socialTest.configs[id];
    export const acquireLock=async()=> 'test-owner';
    export const releaseLock=async()=>{globalThis.socialTest.releases++;};
    export const sameOrigin=r=>r.headers.get('origin')===new URL(r.url).origin;`,
};
const loader = `const mocks=${JSON.stringify(mocks)};
  export async function resolve(specifier, context, next){
    if(mocks[specifier])return {url:'data:text/javascript,'+encodeURIComponent(mocks[specifier]),shortCircuit:true};
    if(specifier.startsWith('@/'))return {url:new URL(specifier.slice(2)+'.ts',${JSON.stringify(root)}).href,shortCircuit:true};
    return next(specifier,context);
  }`;
register('data:text/javascript,'+encodeURIComponent(loader), import.meta.url);

const state = globalThis.socialTest = {env:{X_BEARER_TOKEN:'fake-test-token'}};
const {GET, POST} = await import('../app/api/social/route.ts');
const address = 'So11111111111111111111111111111111111111112';
const evidence = {address,posts:[{text:'Public contract evidence',url:'https://x.com/i/status/123',author:'public-author'}],summary:{sampleSize:1,uniqueAuthors:1,duplicateText:0,engagement:0},asOf:'2026-09-17T00:00:00.000Z'};
const request = (method='GET',origin='https://test.local') => new Request('https://test.local/api/social?address='+address, {
  method, ...(method==='POST'?{headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({address})}:{}),
});
beforeEach(()=>{
  state.user={userId:'A'}; state.env.X_BEARER_TOKEN='fake-test-token';
  state.configs={A:{xDailyRequests:10},B:{xDailyRequests:3}};
  state.usage={A:4,B:1};state.cache={data:JSON.stringify({...evidence,usedToday:4,dailyLimit:10,status:'connected',configured:true,message:'LEGACY',privateField:'must not leak'}),fetched_at:Date.now()};
  state.fetches=0;state.writes=0;state.reservations=0;state.releases=0;
  state.db={prepare(sql){return {bind(...args){return {
    async first(){
      if(sql.startsWith('SELECT data, fetched_at'))return state.cache;
      if(sql.startsWith('SELECT requests'))return {requests:state.usage[args[0].split(':')[1]]||0};
      if(sql.startsWith('INSERT INTO social_usage')){
        state.reservations++;
        const user=args[0].split(':')[1];
        if(state.usage[user]>=args[1])return null;
        return {requests:++state.usage[user]};
      }
      throw Error('Unexpected SQL: '+sql);
    },
    async run(){
      assert.ok(sql.startsWith('INSERT INTO social_cache'));
      state.writes++;state.cache={data:args[1],fetched_at:args[2]};return {};
    },
  };}};}};
  globalThis.fetch=async()=>{state.fetches++;return Response.json({data:[{id:'123',text:'Public contract evidence',author_id:'public-author'}]});};
});

test('POST legacy shared cache returns each caller’s current quota, without charging',async()=>{
  for(const user of ['A','B']){
    state.user={userId:user};const response=await POST(request('POST'));const data=await response.json();
    assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.equal(data.usedToday,state.usage[user]);assert.equal(data.dailyLimit,state.configs[user].xDailyRequests);
    assert.equal(data.privateField,undefined);assert.notEqual(data.message,'LEGACY');assert.deepEqual(data.posts,evidence.posts);
  }
  assert.equal(state.fetches,0);assert.equal(state.reservations,0);assert.equal(state.releases,2);
});
test('GET legacy shared cache returns the current user’s state',async()=>{
  state.user={userId:'B'};const data=await (await GET(request())).json();
  assert.equal(data.usedToday,1);assert.equal(data.dailyLimit,3);assert.equal(data.privateField,undefined);
  assert.equal(data.cached,true);assert.equal(data.stale,false);
});
test('removing the credential overrides legacy connection and message fields',async()=>{
  delete state.env.X_BEARER_TOKEN;
  const data=await (await GET(request())).json();
  assert.equal(data.configured,false);assert.equal(data.status,'not_connected');assert.match(data.message,/Add X_BEARER_TOKEN/);
  assert.deepEqual(data.posts,evidence.posts);
  assert.equal((await POST(request('POST'))).status,409);assert.equal(state.fetches,0);
});
test('new writes persist evidence only and return request-specific quota',async()=>{
  state.cache=null;state.user={userId:'B'};
  const data=await (await POST(request('POST'))).json();
  assert.equal(data.usedToday,2);assert.equal(data.dailyLimit,3);assert.equal(data.cached,false);
  assert.equal(state.fetches,1);assert.equal(state.writes,1);assert.equal(state.reservations,1);
  const saved=JSON.parse(state.cache.data);
  assert.deepEqual(Object.keys(saved).sort(),['address','asOf','posts','summary']);
  state.user={userId:'A'};
  const cached=await (await POST(request('POST'))).json();
  assert.equal(cached.usedToday,4);assert.equal(cached.dailyLimit,10);assert.equal(state.fetches,1);
});
test('zero budget permits free cache reads, but blocks a paid refresh',async()=>{
  state.configs.A.xDailyRequests=0;
  assert.equal((await POST(request('POST'))).status,200);
  state.cache.fetched_at=Date.now()-900001;
  assert.equal((await POST(request('POST'))).status,429);assert.equal(state.fetches,0);
});
test('stale GET evidence is labelled, while POST refreshes it',async()=>{
  state.cache.fetched_at=Date.now()-900001;
  assert.equal((await (await GET(request())).json()).stale,true);
  assert.equal((await (await POST(request('POST'))).json()).cached,false);assert.equal(state.fetches,1);
});
test('unauthenticated and cross-origin calls cannot reach the paid provider',async()=>{
  state.user=null;
  assert.equal((await GET(request())).status,401);assert.equal((await POST(request('POST'))).status,401);
  state.user={userId:'A'};
  assert.equal((await POST(request('POST','https://elsewhere.test'))).status,403);
  assert.equal(state.fetches,0);assert.equal(state.reservations,0);
});
test('a reached daily cap rejects a cache miss without a provider call',async()=>{
  state.cache=null;state.usage.A=10;
  assert.equal((await POST(request('POST'))).status,429);assert.equal(state.fetches,0);
});
