import {PaperAccount, type Print, type Side} from './paper';
import type {Book} from './market';

export const QUEUE_VERSION='queue-reactive-v1';
export interface Rates { bidAdd:number; bidRemove:number; askAdd:number; askRemove:number; sellVolume:number; buyVolume:number; unit:number; samples:number; seconds:number }
export class QueueRates {
  rates:Rates={bidAdd:0,bidRemove:0,askAdd:0,askRemove:0,sellVolume:0,buyVolume:0,unit:200,samples:0,seconds:0};
  previous:{book:Book;ts:number}|null=null;
  update(book:Book,prints:Print[],ts:number) {
    const p=this.previous;this.previous={book,ts};
    if(!p)return false;
    const dt=(ts-p.ts)/1000;
    if(dt<=0||dt>3){this.rates.seconds=0;return false;}
    const r=this.rates,alpha=1-Math.exp(-dt/20);
    const sum=(side:Side,price:number)=>prints.filter(t=>t.side===side&&Math.abs(t.price-price)<1e-10).reduce((s,t)=>s+t.size,0);
    // Same-price residuals are NET additions/removals, not identified cancellation events.
    const updateSide=(side:'bid'|'ask')=>{
      const levels=side==='bid'?'bids':'asks',oldQ=p.book.levels[levels][0]?.[1]??0;
      if(book[side]!==p.book[side])return;
      const volume=sum(side==='bid'?'sell':'buy',book[side]);
      const residual=(book.levels[levels][0]?.[1]??0)-oldQ+volume;
      const add=Math.max(0,residual)/dt,remove=(volume+Math.max(0,-residual))/dt;
      const ak=side==='bid'?'bidAdd':'askAdd',rk=side==='bid'?'bidRemove':'askRemove';
      r[ak]+=alpha*(add-r[ak]);r[rk]+=alpha*(remove-r[rk]);
    };
    updateSide('bid');updateSide('ask');
    r.sellVolume+=alpha*(sum('sell',p.book.bid)/dt-r.sellVolume);
    r.buyVolume+=alpha*(sum('buy',p.book.ask)/dt-r.buyVolume);
    if(prints.length){const sizes=prints.map(t=>t.size).sort((a,b)=>a-b);r.unit+=alpha*(Math.max(1,sizes[Math.floor(sizes.length/2)]!)-r.unit);}
    r.samples++;r.seconds+=dt;return true;
  }
}

/** Constant-rate birth/death first-passage approximation, not a fitted venue model.
 * Stop each path at the first best-queue depletion. Do NOT extrapolate to multiple ticks. */
export function forecast(book:Book,r:Rates,seed=book.block,paths=128,horizon=30) {
  let state=(seed>>>0)||1;
  const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return ((state>>>0)+.5)/4294967296;};
  const unit=Math.max(1,r.unit),rates=[r.bidAdd,r.bidRemove,r.askAdd,r.askRemove].map(v=>Math.max(0,v)/unit);
  const total=rates.reduce((s,v)=>s+v,0);
  let up=0,down=0,unchanged=0,truncated=0,totalTime=0;
  for(let k=0;k<paths;k++){
    let bid=book.levels.bids[0]?.[1]??0,ask=book.levels.asks[0]?.[1]??0,time=0,finished=false;
    if(total===0){unchanged++;continue;}
    for(let event=0;event<1024;event++){
      time+=-Math.log(random())/total;
      if(time>horizon){unchanged++;finished=true;break;}
      const x=random()*total;
      if(x<rates[0]!)bid+=unit;
      else if(x<rates[0]!+rates[1]!)bid-=unit;
      else if(x<rates[0]!+rates[1]!+rates[2]!)ask+=unit;
      else ask-=unit;
      if(bid<=0||ask<=0){if(ask<=0)up++;else down++;totalTime+=time;finished=true;break;}
    }
    if(!finished)truncated++;
  }
  const upStep=((book.levels.asks[1]?.[0]??book.ask)-book.ask)/2/book.mid*10000;
  const downStep=(book.bid-(book.levels.bids[1]?.[0]??book.bid))/2/book.mid*10000;
  return {upProbability:up/paths,downProbability:down/paths,noMoveProbability:unchanged/paths,truncatedProbability:truncated/paths,
    meanDepletionSeconds:up+down?totalTime/(up+down):null,firstMoveBps:(up*upStep-down*downStep)/paths,
    ready:r.seconds>=60&&truncated===0,paths,horizonSeconds:horizon};
}

export interface QueueOrder { id:string; ahead:number; armed:boolean; placedAt:number; cancelAfter:number|null }
/** Counterfactual queue: join the touch behind ALL displayed volume.
 * Queue-ahead only declines from observed opposing trades; no cancellation credit.
 * Arm on first post-arrival snapshot, before allowing any later-block fills. */
export class QueueAccount extends PaperAccount {
  queue:QueueOrder|null=null;
  cancels=0;
  postOnlyRejected=0;
  gapCancellations=0;
  readonly arm='queue';
  place(side:Side,book:Book,arrival:number,ts:number,id:string) {
    if(this.order)return false;
    const price=side==='buy'?book.bid:book.ask;
    if(!super.quote(side,price,200,arrival,book.mid))return false;
    this.queue={id,ahead:0,armed:false,placedAt:ts,cancelAfter:null};return true;
  }
  requestCancel(block:number,mid:number) {
    if(!this.order||!this.queue||this.queue.cancelAfter!==null)return false;
    this.queue.cancelAfter=block;const gas=this.costs.gasMon*mid;this.cash-=gas;this.gasUsd+=gas;this.cancels++;return true;
  }
  armAt(book:Book) {
    const o=this.order,q=this.queue;if(!o||!q||q.armed||book.block<=o.activeAfter)return;
    if(o.side==='buy'?o.price>=book.ask:o.price<=book.bid){this.order=null;this.queue=null;this.postOnlyRejected++;return;}
    const levels=o.side==='buy'?book.levels.bids:book.levels.asks;
    const level=levels.find(l=>Math.abs(l[0]-o.price)<1e-10);
    // Outside visible depth: cannot reconstruct the queue; abandon instead of assuming zero.
    if(!levels.length||(!level&&(o.side==='buy'?o.price<levels.at(-1)![0]:o.price>levels.at(-1)![0]))){this.order=null;this.queue=null;this.gapCancellations++;return;}
    q.ahead=level?.[1]??0;q.armed=true;o.activeAfter=book.block;
  }
  override consume(p:Print) {
    const o=this.order,q=this.queue;if(!o||!q)return 0;
    if(q.cancelAfter!==null&&p.block>=q.cancelAfter){this.order=null;this.queue=null;return 0;}
    if(!q.armed||p.block<=o.activeAfter)return 0;
    if(!(o.side==='buy'?p.side==='sell'&&p.price<=o.price:p.side==='buy'&&p.price>=o.price))return 0;
    const used=Math.min(q.ahead,p.size);q.ahead-=used;
    const eligible=Math.min(p.size-used,p.size*this.costs.participation,o.remaining);
    if(eligible<=0)return 0;
    // Reuse tested cash/inventory accounting with an explicitly bounded synthetic print.
    const filled=super.consume({...p,price:o.side==='buy'?o.price*(1-1e-8):o.price*(1+1e-8),size:eligible/this.costs.participation});
    if(!this.order)this.queue=null;return filled;
  }
  finishBlock(block:number){if(this.queue?.cancelAfter!==null&&this.queue?.cancelAfter!==undefined&&block>=this.queue.cancelAfter){this.order=null;this.queue=null;}}
}

export function choose(book:Book,r:Rates,f:ReturnType<typeof forecast>,a:QueueAccount,blind=false) {
  if(!f.ready)return {action:'abstain' as const,reason:'warmup_or_truncated'};
  const side:Side=blind?(a.mon*book.mid>a.cash?'sell':'buy'):(f.upProbability>=f.downProbability?'buy':'sell');
  const price=side==='buy'?book.bid:book.ask;
  const fraction=(a.mon+(side==='buy'?200:-200))*book.mid/(a.cash+a.mon*book.mid);
  if(fraction<.2||fraction>.8)return {action:'abstain' as const,reason:'inventory_limit'};
  if(!blind){
    const p=side==='buy'?f.upProbability:f.downProbability;
    if(p<.6)return {action:'abstain' as const,reason:'weak_depletion_signal'};
    const volume=side==='buy'?r.sellVolume:r.buyVolume;
    const ahead=(side==='buy'?book.levels.bids:book.levels.asks)[0]![1];
    const wait=(ahead+200)/Math.max(volume,1e-12);
    if(wait>30)return {action:'abstain' as const,reason:'queue_too_long'};
  }
  // Mark-to-mid screening score, NOT round-trip or conditional-fill EV.
  // Both arms use the same costs; blind sets the directional forecast to zero.
  const directional=blind?0:(side==='buy'?1:-1)*f.firstMoveBps;
  const entry=(side==='buy'?book.mid-price:price-book.mid)/book.mid*10000;
  const cost=3*a.costs.gasMon/200*10000+2*a.costs.feeBps+2;
  const edge=entry+directional-cost;
  if(edge<=0)return {action:'abstain' as const,reason:'insufficient_edge',edgeBps:edge};
  return {action:side,reason:'quote',edgeBps:edge};
}
