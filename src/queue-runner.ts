import {Database} from 'bun:sqlite';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Market} from './market';
import {TradeFeed} from './trades';
import {log10} from './book';
import {config} from './config';
import {QueueAccount,QueueRates,forecast,choose,QUEUE_VERSION} from './queue';
if(process.env.DRY_RUN!=='true')throw new Error('Explicit DRY_RUN=true required');
const dir=process.env.RAILWAY_VOLUME_MOUNT_PATH??process.env.DATA_DIR??'data';mkdirSync(dir,{recursive:true});
const db=new Database(join(dir,'research.sqlite'),{create:true});
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS queue_checkpoint(key TEXT PRIMARY KEY,payload TEXT);
CREATE TABLE IF NOT EXISTS queue_events(id INTEGER PRIMARY KEY,run TEXT,ts INTEGER,type TEXT,payload TEXT);`);
const read=(table:string,key:string)=>{const row=db.query(`SELECT payload FROM ${table} WHERE key=?`).get(key) as any;return row?JSON.parse(row.payload):null;};
const previous=read('enriched_checkpoint','enriched-jev-v1');
if(!previous?.trial?.deadline)throw new Error('Missing original trial deadline; refusing a new trial budget');
const saved=read('queue_checkpoint',QUEUE_VERSION);
const id=saved?.id??crypto.randomUUID(),started=saved?.started??Date.now(),deadline=previous.trial.deadline;
const costs={gasMon:.0357,feeBps:0,participation:.1};
const accounts:Record<string,QueueAccount>={};
for(const [name,a] of Object.entries(saved?.accounts??{}) as [string,any][]){
 const restored=Object.assign(new QueueAccount(a.initialUsd,a.initialMid,a.costs),a);
 if(restored.order){restored.requestCancel(0,saved.latest.mid);restored.finishBlock(0);restored.gapCancellations++;}
 accounts[name]=restored;
}
const estimator=new QueueRates();
let latest:any=saved?.latest??null,samples=saved?.samples??0,errors=saved?.errors??0,gaps=saved?.gaps??0;
let busy=false,lastBlock=0,lastAt=0,lastDecision=0,pending:any[]=saved?.pending??[];
const counts:Record<string,number>=saved?.counts??{},evaluation:Record<string,any>=saved?.evaluation??{};
const assumptions={version:QUEUE_VERSION,paperOnly:true,initialUsd:100,costs,deadline,aiCalls:0,
 comparison:'Fresh queue_signal vs queue_blind; identical queue fills, costs, TTL and inventory limits. Earlier arms frozen.',
 limitations:['FIFO is an unverified venue approximation','One-second depth snapshots cannot identify all arrivals and cancellations','Constant-rate first-depletion model, not calibrated probabilities','No credit for cancellations ahead; no impact or hidden-liquidity model','Mark-to-mid score is not round-trip expected profit','Gas and fees are scenarios; hosting excluded']};
function event(type:string,payload:any,ts=Date.now()){db.query('INSERT INTO queue_events(run,ts,type,payload) VALUES (?,?,?,?)').run(id,ts,type,JSON.stringify(payload));}
function save(){db.query('INSERT OR REPLACE INTO queue_checkpoint VALUES (?,?)').run(QUEUE_VERSION,JSON.stringify({id,started,accounts,latest,samples,errors,gaps,pending,counts,evaluation}));}
const market=new Market();await market.init();
const feed=new TradeFeed({market:config.market,url:config.readRpcUrl,sizeDec:log10(market.params.sizePrecision)});
// Only migrate after successful market initialization. Freeze, never reset, the paid trial.
db.transaction(()=>{
 if(!previous.queueReplacement){
  previous.trial.paused=true;previous.trial.reason='replaced_by_queue';
  previous.stopSnapshot=previous.stopSnapshot??structuredClone(previous.latest);
  previous.queueReplacement={run:id,at:Date.now(),lastObserved:previous.latest,aiCostUpperBoundUsd:previous.trial.chargedUsd};
  for(const a of Object.values(previous.accounts) as any[])a.order=null;
  db.query('INSERT OR REPLACE INTO enriched_checkpoint VALUES (?,?)').run('enriched-jev-v1',JSON.stringify(previous));
 }
 db.query('INSERT OR IGNORE INTO runs VALUES (?,?,?,NULL)').run(id,started,JSON.stringify(assumptions));save();
})();
Bun.serve({port:config.port,fetch(req){const u=new URL(req.url);
 if(u.pathname==='/health')return Response.json({ok:!!latest&&Date.now()-latest.ts<15000},{status:latest&&Date.now()-latest.ts<15000?200:503});
 const token=process.env.METRICS_TOKEN;if(token&&req.headers.get('authorization')!==`Bearer ${token}`)return new Response('Unauthorized',{status:401});
 if(u.pathname==='/'||u.pathname==='/summary')return Response.json({runId:id,started,assumptions,latest,previousAi:previous.queueReplacement});
 if(u.pathname==='/runs')return Response.json(db.query('SELECT * FROM runs ORDER BY started DESC LIMIT 100').all());
 if(u.pathname==='/decisions'||u.pathname==='/outcomes')return Response.json(db.query('SELECT * FROM queue_events WHERE run=? AND type=? ORDER BY id DESC LIMIT 1000').all(id,u.pathname==='/decisions'?'decision':'outcome'));
 if(u.pathname==='/export'){const after=Number(u.searchParams.get('after')??0);if(!Number.isSafeInteger(after)||after<0)return new Response('Invalid cursor',{status:400});const rows=db.query('SELECT * FROM observations WHERE id>? ORDER BY id LIMIT 1000').all(after) as any[];return Response.json({nextCursor:rows.at(-1)?.id??after,rows:rows.map(r=>({...r,payload:JSON.parse(r.payload)}))});}
 return new Response('Not found',{status:404});
}});
console.log('QUEUE_START '+JSON.stringify({runId:id,started,assumptions,previousAi:previous.queueReplacement}));
async function sample(){if(busy)return;busy=true;
 try{
  const begin=performance.now(),book=await market.readBook();
  if(![book.mid,book.bid,book.ask].every(x=>Number.isFinite(x)&&x>0)||book.ask<book.bid||!book.levels.bids.length||!book.levels.asks.length)throw new Error('Invalid book');
  if(book.block<=lastBlock)return;
  await feed.poll(book.block);if(feed.lastBlock<book.block)throw new Error('Trade feed behind book');
  const now=Date.now(),gap=!lastAt||now-lastAt>3000||performance.now()-begin>2000;
  const prints=feed.drainPrints().filter(p=>lastBlock>0&&p.block>lastBlock&&p.block<=book.block);
  if(!accounts.queue_signal)for(const name of ['queue_signal','queue_blind'])accounts[name]=new QueueAccount(100,book.mid,costs);
  if(gap){gaps++;estimator.previous=null;estimator.rates.seconds=0;for(const a of Object.values(accounts)){if(a.order){a.requestCancel(book.block,book.mid);a.finishBlock(book.block);a.gapCancellations++;}}}
  for(const [name,a] of Object.entries(accounts)){
   if(!gap)for(const p of prints){const o=a.order?{...a.order}:null,q=a.queue?{...a.queue}:null;const filled=a.consume(p);if(filled&&o){event('fill',{strategy:name,price:o.price,size:filled,queue:q,print:p},now);for(const seconds of [5,15,30,60])pending.push({type:'markout',strategy:name,seconds,due:now+seconds*1000,price:o.price,side:o.side,size:filled,gaps});}}
   a.finishBlock(book.block);a.armAt(book);
  }
  estimator.update(book,gap?[]:prints,now);const prediction=forecast(book,estimator.rates);
  for(const job of pending.filter(j=>j.due<=now)){
   const valid=now-job.due<3000&&job.gaps===gaps;
   const value=job.type==='markout'?(job.side==='buy'?1:-1)*(book.mid/job.price-1)*10000:(book.mid/job.mid-1)*10000;
   event('outcome',{...job,valid,observedAt:now,labelLagMs:now-job.due,markoutOrReturnBps:value},now);
   const key=job.strategy+':'+job.type+':'+job.seconds,e=evaluation[key]??={count:0,invalid:0,sumBps:0};if(valid){e.count++;e.sumBps+=value;}else e.invalid++;
  }
  pending=pending.filter(j=>j.due>now);
  const actions:any[]=[],arrival=book.block+Math.ceil((performance.now()-begin)/300)+1;
  for(const a of Object.values(accounts))if(a.queue&&(now-a.queue.placedAt>=30000||now>=deadline))a.requestCancel(arrival,book.mid);
  if(now-lastDecision>=5000){lastDecision=now;
   for(const [name,a] of Object.entries(accounts)){
    const decision=now>=deadline?{action:'abstain',reason:'original_deadline'}:gap?{action:'abstain',reason:'data_gap'}:choose(book,estimator.rates,prediction,a,name==='queue_blind');
    let submitted=false;const decisionId=crypto.randomUUID();
    if(!a.order&&(decision.action==='buy'||decision.action==='sell'))submitted=a.place(decision.action,book,arrival,now,decisionId);
    const reason=a.order&&!submitted?'existing_order':decision.reason;counts[name+':'+reason]=(counts[name+':'+reason]??0)+1;
    const payload={strategy:name,decisionId,decision,reason,submitted,book,rates:estimator.rates,prediction,queue:a.queue};event('decision',payload,now);actions.push({strategy:name,decision,reason,submitted});
    pending.push({type:'forecast',strategy:name,seconds:30,due:now+30000,mid:book.mid,prediction,gaps,decisionId});
   }
  }
  lastAt=now;lastBlock=book.block;samples++;
  const metrics=Object.fromEntries(Object.entries(accounts).map(([name,a])=>[name,{...a.metrics(book.mid),queue:a.queue,cancels:a.cancels,postOnlyRejected:a.postOnlyRejected,gapCancellations:a.gapCancellations,aiCostUsd:0}]));
  latest={ts:now,block:book.block,mid:book.mid,samples,errors,gaps,status:now>=deadline?'deadline_reached':prediction.ready?'running':'warming',previousAiPaused:true,previousAiCostUpperBoundUsd:previous.trial.chargedUsd,aiCalls:0,aiCostUsd:0,rates:estimator.rates,prediction,strategies:metrics,actions,counts,evaluation};
  db.transaction(()=>{save();db.query('INSERT INTO observations(run,ts,payload) VALUES (?,?,?)').run(id,now,JSON.stringify({book,prints,metrics:latest}));db.query('UPDATE runs SET summary=? WHERE id=?').run(JSON.stringify(latest),id);if(samples%60===0)db.exec('DELETE FROM observations WHERE id <= (SELECT MAX(id)-100000 FROM observations)');})();
  if(samples===1||samples%60===0)console.log('QUEUE_SUMMARY '+JSON.stringify({runId:id,started,...latest}));
 }catch(e){errors++;console.error('QUEUE_ERROR '+(e as Error).message);}finally{busy=false;}
}
setInterval(sample,1000);await sample();
