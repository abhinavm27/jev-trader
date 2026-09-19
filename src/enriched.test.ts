import {test,expect} from 'bun:test';
import {context,stateFor,gate,cancel,EnrichedModel,type EnrichedDecision,type Point} from './enriched';
import {PaperAccount} from './paper';
import {Trial} from './trial';
const now=1000000;
const points:Point[]=Array.from({length:901},(_,i)=>({ts:now-900000+i*1000,mid:1+i*.000001,spreadBps:2,imbalance:.1,buy:3,sell:2,notional:5*(1+i*.000001)}));
const book:any={mid:1,bid:.9999,ask:1.0001,spreadBps:2,imbalance:.2,depthBps:{},levels:{bids:[[.9999,200]],asks:[[1.0001,200]]}};
const account=()=>new PaperAccount(1000,1,{gasMon:.0357,feeBps:0,participation:.1});
const state=()=>stateFor(book,context(points,now),account(),now,now-20000,now-5000,100);
const decision:EnrichedDecision={action:'buy',confidence:.8,moveBps:20,moveDistribution:{},buyFill:.8,sellFill:.8,inputTokens:100,latencyMs:1};
test('windows exclude future observations and flag missing coverage',()=>{
 const a=context(points,now),b=context([...points,{...points[0]!,ts:now+1,mid:999}],now);
 expect(a).toEqual(b);expect((a[900] as any).ready).toBe(true);
 expect((context(points.slice(-40),now)[900] as any).ready).toBe(false);
 expect((context(points.filter(p=>p.ts<now-10000||p.ts>now-1000),now)[60] as any).ready).toBe(false);
});
test('gate enforces cost, confidence, inventory, freshness and cooldown',()=>{
 const s=state();expect(gate(decision,s,.9999,now,now-20000)).toBe('trade');
 expect(gate({...decision,moveBps:1},s,.9999,now,0)).toBe('insufficient_edge');
 expect(gate({...decision,buyFill:.1},s,.9999,now,0)).toBe('low_confidence');
 s.execution.dataAgeMs=3000;expect(gate(decision,s,.9999,now,0)).toBe('stale');s.execution.dataAgeMs=100;
 s.portfolio.inventoryMon=790;expect(gate(decision,s,.9999,now,0)).toBe('inventory_limit');s.portfolio.inventoryMon=500;
 s.portfolio.outstandingOrder={side:'buy',price:.99,remaining:200,activeAfter:1};expect(gate(decision,s,.9999,now,now-1000)).toBe('replace_cooldown');
});
test('abstain/keep/cancel are explicit; cancellation charges only once',()=>{
 for(const action of ['abstain','keep','cancel'] as const)expect(gate({...decision,action},state(),1,now,0)).toBe(action);
 const a=account();a.quote('buy',.9999,200,1,1);const gas=a.gasUsd;
 expect(cancel(a,1)).toBe(true);expect(a.gasUsd).toBeCloseTo(gas+.0357);expect(cancel(a,1)).toBe(false);expect(a.order).toBeNull();
});
test('migration retains spend and deadline rather than starting a new allowance',()=>{
 const old=new Trial();old.chargedUsd=1.2;old.deadline=now;old.paused=true;
 const next=Object.assign(new Trial(),JSON.parse(JSON.stringify(old)));next.paused=false;
 expect(next.chargedUsd).toBe(1.2);expect(next.deadline).toBe(now);expect(next.reserve(now)).toBe(false);
});
const answer={answers:{action:{choice:'abstain',probabilities:{buy:.05,sell:.05,keep:0,cancel:0,abstain:.9}},move30:{choice:'flat',probabilities:{down20:0,down10:0,down5:.1,flat:.8,up5:.1,up10:0,up20:0}},buyFill:{noul:.3},sellFill:{noul:.4}},usage:{input_tokens:1900}};
test('typed API maps all outputs, pinned model and tokens without retry',async()=>{
 let calls=0;
 const request=(async(url:any,options:any)=>{calls++;const b=JSON.parse(options.body);expect(b.model).toBe('typesafe/jev-1.13');expect(Object.keys(b.questions)).toHaveLength(4);return Response.json(answer);});
 const d=await new EnrichedModel('test-only',request).decide(state());expect(d.action).toBe('abstain');expect(d.moveBps).toBe(0);expect(d.inputTokens).toBe(1900);expect(calls).toBe(1);
});
test('invalid provider probabilities fail closed',async()=>{
 const bad=structuredClone(answer);bad.answers.buyFill.noul=2;
 await expect(new EnrichedModel('test-only',(async()=>Response.json(bad))).decide(state())).rejects.toThrow('Invalid');
});
