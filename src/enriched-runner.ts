import {Database} from 'bun:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Market} from './market';
import {TradeFeed} from './trades';
import {log10} from './book';
import {config} from './config';
import {PaperAccount} from './paper';
import {Trial} from './trial';
import {VERSION,EnrichedModel,context,stateFor,ruleDecision,gate,cancel,type Point} from './enriched';
if(process.env.DRY_RUN!=='true')throw new Error('Explicit DRY_RUN=true required');
if(config.openRouterModelId!=='typesafe/jev-1.13')throw new Error('Pinned model required');
const dir=process.env.RAILWAY_VOLUME_MOUNT_PATH??process.env.DATA_DIR??'data';mkdirSync(dir,{recursive:true});
const db=new Database(join(dir,'research.sqlite'),{create:true});
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS enriched_checkpoint(key TEXT PRIMARY KEY,payload TEXT);
CREATE TABLE IF NOT EXISTS enriched_decisions(id TEXT PRIMARY KEY,run TEXT,ts INTEGER,payload TEXT);
CREATE TABLE IF NOT EXISTS enriched_outcomes(id INTEGER PRIMARY KEY,run TEXT,ts INTEGER,payload TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS enriched_outcome_once ON enriched_outcomes(run, json_extract(payload,'$.outcomeId'));`);
const read=(table:string,key:string)=>{const row=db.query(`SELECT payload FROM ${table} WHERE key=?`).get(key) as any;return row?JSON.parse(row.payload):null;};
const old=read('parallel_checkpoint','trial-v1');
if(!old?.trial?.paused)throw new Error('Original AI trial must be durably paused before migration');
const saved=read('enriched_checkpoint',VERSION);
const trial=Object.assign(new Trial(),saved?.trial??old.trial);
// Explicit one-time migration starts the new arm; original checkpoint stays paused forever.
if(!saved){trial.paused=false;trial.reason=null;trial.consecutiveFailures=0;}
if(process.env.ENRICHED_AI_PAUSED!=='false'){trial.paused=true;trial.reason='operator';}
const id=saved?.id??crypto.randomUUID(),started=saved?.started??Date.now();
const inheritedCost=saved?.inheritedCost??old.trial.chargedUsd;
const accounts:Record<string,PaperAccount>={};
for(const [name,a] of Object.entries(saved?.accounts??{legacy_momentum:old.accounts.momentum}) as [string,any][]){accounts[name]=Object.assign(new PaperAccount(a.initialUsd,a.initialMid,a.costs),a,{order:null});}
const costs={gasMon:.0357,feeBps:0,participation:.1};
let latest:any=saved?.latest??null, samples=saved?.samples??0,errors=saved?.errors??0,gaps=(saved?.gaps??0)+(saved?1:0),busy=false,lastBlock=0,lastAt=0,lastDecision=0;
let stopSnapshot:any=saved?.stopSnapshot??null;
const counts:Record<string,number>=saved?.counts??{};
const evaluation:Record<string,any>=saved?.evaluation??{};
const orderAt:Record<string,number>={},fillAt:Record<string,number>=saved?.fillAt??{},orderIds:Record<string,string>={};
let pending:any[]=saved?.pending??[];
let points:Point[]=[];
const rows=db.query('SELECT ts,payload FROM observations WHERE ts>? ORDER BY id DESC LIMIT 1200').all(Date.now()-905000) as any[];
const seen=new Set<number>();let historicalBlock=0;
for(const row of rows.reverse()){
 const p=JSON.parse(row.payload),b=p.book;if(!b||seen.has(b.block))continue;seen.add(b.block);historicalBlock=Math.max(historicalBlock,b.block);
 const trades=p.prints??[];points.push({ts:row.ts,mid:b.mid,spreadBps:b.spreadBps,imbalance:b.imbalance,buy:trades.filter((p:any)=>p.side==='buy').reduce((s:number,p:any)=>s+p.size,0),sell:trades.filter((p:any)=>p.side==='sell').reduce((s:number,p:any)=>s+p.size,0),notional:trades.reduce((s:number,p:any)=>s+p.size*p.price,0)});
}
function save(){db.query('INSERT OR REPLACE INTO enriched_checkpoint VALUES (?,?)').run(VERSION,JSON.stringify({id,started,inheritedCost,trial,accounts,latest,samples,errors,gaps,counts,evaluation,pending,stopSnapshot,fillAt}));}
save();
const model=new EnrichedModel(),market=new Market();await market.init();
const feed=new TradeFeed({market:config.market,url:config.readRpcUrl,sizeDec:log10(market.params.sizePrecision)});
const tick=Number(market.params.tickSize.toString())/Number(market.params.pricePrecision.toString());
const assumptions={version:VERSION,initialUsd:100,allocation:'50% cash/50% MON',costs,feesVerified:false,gasVerified:false,hostingMeasured:false,
 sharedTotalAiCapUsd:trial.capUsd,originalDeadline:trial.deadline,oldAiCostUsd:inheritedCost,parentRun:old.id,
 comparison:'enriched_jev versus enriched_rules, equal fresh accounts and identical execution gates; legacy_momentum is continuation only',
 limitations:['Paper fills lack queue reconstruction','Cancellation/replacement is instantaneous in simulation; arrival gating applies to new orders','Predicted edge and fill probabilities are uncalibrated','Fixed representative return buckets truncate tails','No external venue data','Context windows use observed one-second snapshots','No automatic model training or prompt changes']};
db.query('INSERT OR IGNORE INTO runs VALUES (?,?,?,NULL)').run(id,started,JSON.stringify(assumptions));
function out(payload:any,now:number){
 const result=db.query('INSERT OR IGNORE INTO enriched_outcomes(run,ts,payload) VALUES (?,?,?)').run(id,now,JSON.stringify(payload));
 if(!result.changes)return;
 const key=payload.strategy+':'+payload.type+':'+payload.seconds;
 const e=evaluation[key]??={count:0,invalid:0,sumBps:0,absoluteErrorBps:0,correctDirection:0,directionalCount:0,submitted:0,anyFill:0,brierSum:0,brierCount:0};
 if(!payload.valid){e.invalid++;return;}e.count++;
 if(payload.type==='fill')e.sumBps+=payload.markoutBps;
 else {
  e.sumBps+=payload.returnBps;
  if(payload.seconds===30){e.absoluteErrorBps+=Math.abs(payload.moveBps-payload.returnBps);
   if(Math.abs(payload.moveBps)>.01&&Math.abs(payload.returnBps)>.01){e.directionalCount++;if(Math.sign(payload.moveBps)===Math.sign(payload.returnBps))e.correctDirection++;}
   const p=payload.distribution;
   if(p&&Object.keys(p).length){const up=p.up5+p.up10+p.up20;e.brierSum+=(up-(payload.returnBps>=2.5?1:0))**2;e.brierCount++;}
  }
  if(payload.submitted){e.submitted++;if(payload.filledMon>0)e.anyFill++;}
 }
}
function count(key:string){counts[key]=(counts[key]??0)+1;}
Bun.serve({port:config.port,fetch(req){const u=new URL(req.url);
 if(u.pathname==='/health')return Response.json({ok:!!latest&&Date.now()-latest.ts<15000,ai:trial.status()},{status:latest&&Date.now()-latest.ts<15000?200:503});
 const token=process.env.METRICS_TOKEN;
 if(token&&req.headers.get('authorization')!==`Bearer ${token}`)return new Response('Unauthorized',{status:401});
 if(u.pathname==='/ai/pause'&&req.method==='POST'){
  if(!token)return new Response('Token required',{status:401});
  trial.paused=true;trial.reason='operator';if(accounts.enriched_jev&&latest)cancel(accounts.enriched_jev,latest.mid);save();
  return Response.json({status:trial.status()});
 }
 if(u.pathname==='/'||u.pathname==='/summary')return Response.json({runId:id,started,assumptions,latest,stopSnapshot,legacyStop:old.stopSnapshot});
 if(u.pathname==='/runs')return Response.json(db.query('SELECT * FROM runs ORDER BY started DESC LIMIT 100').all());
 if(u.pathname==='/outcomes')return Response.json(db.query('SELECT * FROM enriched_outcomes WHERE run=? ORDER BY id DESC LIMIT 1000').all(id));
 if(u.pathname==='/decisions')return Response.json(db.query('SELECT * FROM enriched_decisions WHERE run=? ORDER BY ts DESC LIMIT 100').all(id));
 if(u.pathname==='/export'){const after=Number(u.searchParams.get('after')??0);if(!Number.isSafeInteger(after)||after<0)return new Response('Invalid cursor',{status:400});const rows=db.query('SELECT * FROM observations WHERE id>? ORDER BY id LIMIT 1000').all(after) as any[];return Response.json({nextCursor:rows.at(-1)?.id??after,rows:rows.map(r=>({...r,payload:JSON.parse(r.payload)}))});}
 return new Response('Not found',{status:404});
}});
console.log('ENRICHED_START '+JSON.stringify({runId:id,started,assumptions}));
async function sample(){
 if(busy){gaps++;return;}busy=true;
 try{
  const t=performance.now(),book=await market.readBook();
  if(![book.mid,book.bid,book.ask].every(x=>Number.isFinite(x)&&x>0)||book.ask<book.bid)throw new Error('Invalid book');
  if(book.block<=lastBlock)return;
  await feed.poll(book.block);if(feed.lastBlock<book.block)return;
  const now=Date.now();if(lastAt&&now-lastAt>3000)gaps++;lastAt=now;lastBlock=book.block;
  const prints=feed.drainPrints().filter(p=>p.block>historicalBlock);historicalBlock=book.block;
  if(!accounts.enriched_jev){accounts.enriched_jev=new PaperAccount(100,book.mid,costs);accounts.enriched_rules=new PaperAccount(100,book.mid,costs);}
  if(trial.status()!=='running')cancel(accounts.enriched_jev,book.mid);
  for(const [name,a] of Object.entries(accounts))for(const p of prints){
   const o=a.order?{...a.order}:null;const filled=a.consume(p);if(!filled||!o)continue;
   fillAt[name]=now;
   for(const job of pending)if(job.type==='decision'&&job.decisionId===orderIds[name]&&now<=job.due)job.filledMon=(job.filledMon??0)+filled;
   for(const seconds of [5,15,30,60])pending.push({outcomeId:crypto.randomUUID(),type:'fill',strategy:name,decisionId:orderIds[name]??null,seconds,due:now+seconds*1000,price:o.price,side:o.side,size:filled});
  }
  points.push({ts:now,mid:book.mid,spreadBps:book.spreadBps,imbalance:book.imbalance,buy:prints.filter(p=>p.side==='buy').reduce((s,p)=>s+p.size,0),sell:prints.filter(p=>p.side==='sell').reduce((s,p)=>s+p.size,0),notional:prints.reduce((s,p)=>s+p.size*p.price,0)});
  points=points.filter(p=>p.ts>=now-901000);const windows=context(points,now);
  for(const job of pending.filter(p=>p.due<=now))db.transaction(()=>{out({...job,observedAt:now,labelLagMs:now-job.due,valid:now-job.due<3000,
   returnBps:job.type==='decision'?(book.mid/job.mid-1)*10000:undefined,
   markoutBps:job.type==='fill'?(job.side==='buy'?1:-1)*(book.mid/job.price-1)*10000:undefined},now);save();})();
  pending=pending.filter(p=>p.due>now);
  const ready=[60,300,900].every(s=>(windows[s] as any)?.ready);
  const actions:any[]=[];
  for(const name of ['enriched_jev','enriched_rules'])if(accounts[name]!.order&&now-(orderAt[name]??0)>=30000){cancel(accounts[name]!,book.mid);count(name+':ttl_cancel');}
  if(now-lastDecision>=5000){
   lastDecision=now;
   // Existing baseline continues using its original rule and balances.
   const legacy=accounts.legacy_momentum!;const w30=windows[30] as any;
   const side=((w30.returnBps??0)/8+book.imbalance*1.5)>=0?'buy':'sell';
   const price=(s:string)=>s==='buy'?Math.min(book.bid+tick,book.ask-tick):Math.max(book.ask-tick,book.bid+tick);
   let aiDecision:any=null;
   const aiState=stateFor(book,windows,accounts.enriched_jev,now,orderAt.enriched_jev??now,fillAt.enriched_jev??started,performance.now()-t);
   if(ready&&performance.now()-t<=2000&&trial.reserve()){
    save();
    try{aiDecision=await model.decide(aiState);trial.settle(aiDecision.inputTokens,aiDecision.latencyMs);}
    catch(e){trial.fail();count('ai_errors');console.error('ENRICHED_AI_ERROR '+(e as Error).message);}
    save();console.log('ENRICHED_AI_USAGE '+JSON.stringify({runId:id,totalCalls:trial.calls,totalCostUsd:trial.chargedUsd,newArmCostUsd:trial.chargedUsd-inheritedCost,tokens:aiDecision?.inputTokens??null,status:trial.status()}));
   }
   const arrival=book.block+Math.ceil((performance.now()-t)/300)+1;
   legacy.quote(side,price(side),200,arrival,book.mid);
   for(const name of ['enriched_jev','enriched_rules']){
    const a=accounts[name]!;
    const state=name==='enriched_jev'?structuredClone(aiState):stateFor(book,windows,a,now,orderAt[name]??now,fillAt[name]??started,performance.now()-t);
    state.execution.dataAgeMs=performance.now()-t;
    const d=name==='enriched_jev'?aiDecision:ready?ruleDecision(state):null;
    if(!d){if(!ready||trial.status()!=='running'&&name==='enriched_jev')cancel(a,book.mid);continue;}
    const key=crypto.randomUUID();
    let reason=gate(d,state,price(d.action),Date.now(),orderAt[name]??0);
    if(name==='enriched_jev'&&(trial.paused||Date.now()>=trial.deadline))reason='stopped';
    let submitted=false;
    if(reason==='trade'){
     // Do not reset a matching partial order or its age.
     if(a.order&&a.order.side===d.action&&a.order.price===price(d.action))reason='keep_matching';
     else {submitted=a.quote(d.action,price(d.action),200,arrival,book.mid);if(submitted){orderAt[name]=now;orderIds[name]=key;}else reason='unfunded';}
    }else if(reason!=='keep'&&reason!=='replace_cooldown')cancel(a,book.mid);
    count(name+':'+reason);actions.push({strategy:name,decisionId:key,action:d.action,reason,submitted,moveBps:d.moveBps});
    db.query('INSERT INTO enriched_decisions VALUES (?,?,?,?)').run(key,id,now,JSON.stringify({strategy:name,state,decision:d,reason,submitted}));
    for(const seconds of [5,15,30,60])pending.push({outcomeId:crypto.randomUUID(),type:'decision',strategy:name,decisionId:key,seconds,due:now+seconds*1000,mid:book.mid,moveBps:d.moveBps,distribution:d.moveDistribution,submitted,filledMon:0});
   }
  }
  samples++;
  const metrics=Object.fromEntries(Object.entries(accounts).map(([name,a])=>{const m=a.metrics(book.mid),aiCost=name==='enriched_jev'?trial.chargedUsd-inheritedCost:0;return [name,{...m,aiCostUpperBoundUsd:aiCost,netAfterAiLowerBoundUsd:m.netBeforeHostingUsd-aiCost,allInUsd:null}];}));
  latest={ts:now,mid:book.mid,block:book.block,samples,errors,gaps,contextReady:ready,windowCoverage:Object.fromEntries(Object.entries(windows).map(([k,v])=>[k,{ready:(v as any).ready,coverage:(v as any).coverage,maxGapMs:(v as any).maxGapMs}])),
   ai:{...trial,status:trial.status(),newArmCostUsd:trial.chargedUsd-inheritedCost},strategies:metrics,actions,decisionCounts:counts,evaluation,
   comparison:{enrichedAiMinusRulesUsd:metrics.enriched_jev!.netAfterAiLowerBoundUsd-metrics.enriched_rules!.netAfterAiLowerBoundUsd,legacyIsSeparatePeriod:true}};
  if(trial.status()!=='running'&&!stopSnapshot){stopSnapshot=JSON.parse(JSON.stringify(latest));console.log('ENRICHED_STOP '+JSON.stringify(stopSnapshot));}
  db.transaction(()=>{
   save();db.query('INSERT INTO observations(run,ts,payload) VALUES (?,?,?)').run(id,now,JSON.stringify({book,prints,metrics:latest}));
   db.query('UPDATE runs SET summary=? WHERE id=?').run(JSON.stringify(latest),id);
   if(samples%60===0)db.exec('DELETE FROM observations WHERE id <= (SELECT MAX(id)-100000 FROM observations)');
  })();
  if(samples===1||samples%60===0)console.log('ENRICHED_SUMMARY '+JSON.stringify({runId:id,started,...latest}));
 }catch(e){errors++;console.error('ENRICHED_ERROR '+(e as Error).message);}
 finally{busy=false;}
}
setInterval(sample,1000);await sample();
