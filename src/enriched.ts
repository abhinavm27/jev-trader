import { config } from './config';
import { PaperAccount, type Side } from './paper';
import type { Book } from './market';
export const VERSION = 'enriched-jev-v1';
export type Action = 'buy'|'sell'|'keep'|'cancel'|'abstain';
export interface Point { ts:number; mid:number; spreadBps:number; imbalance:number; buy:number; sell:number; notional:number }
const round = (x:number) => Math.round(x*1e6)/1e6;
export function context(points:Point[], now:number) {
  const clean=points.filter(p=>p.ts<=now && p.ts>=now-901000).sort((a,b)=>a.ts-b.ts);
  return Object.fromEntries([30,60,300,900].map(sec=>{
    const rows=clean.filter(p=>p.ts>=now-sec*1000), first=rows[0], last=rows.at(-1);
    if(!first||!last) return [sec,{ready:false,samples:0}];
    let variance=0,maxGap=0;
    for(let i=1;i<rows.length;i++){variance+=Math.log(rows[i]!.mid/rows[i-1]!.mid)**2;maxGap=Math.max(maxGap,rows[i]!.ts-rows[i-1]!.ts);}
    const buy=rows.reduce((s,p)=>s+p.buy,0),sell=rows.reduce((s,p)=>s+p.sell,0),vol=buy+sell;
    const vwap=vol?rows.reduce((s,p)=>s+p.notional,0)/vol:null;
    const prices=rows.map(p=>p.mid), low=Math.min(...prices),high=Math.max(...prices);
    const coverage=(last.ts-first.ts)/(sec*1000);
    return [sec,{ready:coverage>=.9&&maxGap<=5000&&now-last.ts<3000,coverage:round(coverage),samples:rows.length,maxGapMs:maxGap,
      returnBps:round((last.mid/first.mid-1)*10000),realizedVolBps:round(Math.sqrt(variance)*10000),
      vwap:vwap===null?null:round(vwap),distanceFromVwapBps:vwap===null?null:round((last.mid/vwap-1)*10000),
      rangePosition:high===low?.5:round((last.mid-low)/(high-low)),rangeBps:round((high/low-1)*10000),
      flowImbalance:vol?round((buy-sell)/vol):0,volumeMon:round(vol),
      meanSpreadBps:round(rows.reduce((s,p)=>s+p.spreadBps,0)/rows.length)}];
  }));
}
export function stateFor(book:Book, windows:ReturnType<typeof context>, a:PaperAccount, now:number, orderAt:number, changedAt:number, dataAgeMs:number) {
 const equity=a.cash+a.mon*book.mid, size=200;
 return {strategy:VERSION,market:'MON-USDC',observedAt:now,horizonSeconds:30,sampleSeconds:1,
   marketState:{mid:book.mid,bid:book.bid,ask:book.ask,spreadBps:book.spreadBps,bookImbalance:book.imbalance,depth:book.depthBps,top5:book.levels},
   windows,portfolio:{cashUsd:a.cash,inventoryMon:a.mon,inventoryFraction:a.mon*book.mid/equity,equityUsd:equity,
    outstandingOrder:a.order,orderAgeSeconds:a.order?(now-orderAt)/1000:null,secondsSinceLastFill:(now-changedAt)/1000},
   execution:{sizeMon:size,dataAgeMs,gasMonPerAction:a.costs.gasMon,gasBpsPerPlacement:a.costs.gasMon/size*10000,
    exchangeFeeBps:a.costs.feeBps,feesVerified:false,costsAreScenarios:true,postOnly:true,
    minInventoryFraction:.2,maxInventoryFraction:.8,orderTtlSeconds:30,minimumReplaceSeconds:15,
    edgeBufferBps:2,adverseSelectionAllowanceBps:2,
    fillModel:'strict trade-through after conservative arrival; 10% participation; queue position unknown'},
   limitations:['One-second snapshots miss subsecond order events','No other-venue data','Predictions are uncalibrated until outcomes accumulate']};
}
const MOVES:Record<string,number>={down20:-20,down10:-10,down5:-5,flat:0,up5:5,up10:10,up20:20};
export interface EnrichedDecision { action:Action; confidence:number; moveBps:number; moveDistribution:Record<string,number>; buyFill:number; sellFill:number; inputTokens:number; latencyMs:number }
function distribution(answer:any, keys:string[]) {
 if(!answer||!keys.includes(answer.choice))throw new Error('Invalid enriched choice');
 const p=answer.probabilities;
 if(!p||keys.some(k=>typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<0||p[k]>1)||Math.abs(keys.reduce((s,k)=>s+p[k],0)-1)>.01)throw new Error('Invalid enriched distribution');
 return p as Record<string,number>;
}
export class EnrichedModel {
 constructor(private key=config.openRouterApiKey,private request:(url:string,init:RequestInit)=>Promise<Response>=fetch){if(!key)throw new Error('Missing OpenRouter key');}
 async decide(state:ReturnType<typeof stateFor>):Promise<EnrichedDecision>{
  const t=performance.now();
  const response=await this.request('https://openrouter.ai/api/alpha/decisions',{method:'POST',headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(2500),body:JSON.stringify({model:'typesafe/jev-1.13',state:JSON.stringify(state),questions:{
   action:{type:'choice',instructions:'Choose a passive spot-trading action for the next 30 seconds. Consider 30s/1m/5m/15m regimes, portfolio, execution costs and uncertainty. Do not force a trade. Keep means retain an existing worthwhile order. Abstain means no new exposure; existing order is cancelled by code. Avoid chasing persistent trends or fading without flow exhaustion. No shorts or borrowing.',criteria:{buy:'A new buy quote has positive expected net benefit after costs and inventory risk.',sell:'A new sell quote has positive expected net benefit after costs and inventory risk.',keep:'Existing order remains worthwhile; avoid replacement cost.',cancel:'Existing order is stale, risky, or no longer worthwhile.',abstain:'No sufficiently supported net-positive opportunity, or incomplete information.'}},
   move30:{type:'choice',instructions:'Estimate the probability distribution of the mid-price RETURN in basis points over the next 30 seconds. Select the closest representative bucket. These are estimates, not guaranteed returns. 1bp=0.01%.',criteria:{down20:'Return below -15 bps',down10:'Return from -15 inclusive to -7.5 exclusive bps',down5:'Return from -7.5 inclusive to -2.5 exclusive bps',flat:'Return from -2.5 inclusive to +2.5 exclusive bps',up5:'Return from +2.5 inclusive to +7.5 exclusive bps',up10:'Return from +7.5 inclusive to +15 exclusive bps',up20:'Return +15 bps or higher'}},
   buyFill:{type:'noul',instructions:'Probability a new 200 MON passive buy near the best bid fills within 30 seconds after arrival. Queue position is unknown; be conservative.',criteria:{true:'Order fills within 30 seconds',false:'Order does not fill within 30 seconds'}},
   sellFill:{type:'noul',instructions:'Probability a new 200 MON passive sell near the best ask fills within 30 seconds after arrival. Queue position is unknown; be conservative.',criteria:{true:'Order fills within 30 seconds',false:'Order does not fill within 30 seconds'}}
  }})});
  if(!response.ok)throw new Error(`OpenRouter enriched HTTP ${response.status}`);
  const body=await response.json() as any,a=body.answers;
  const p=distribution(a?.action,['buy','sell','keep','cancel','abstain']);
  const moves=distribution(a?.move30,Object.keys(MOVES));
  const buyFill=a?.buyFill?.noul,sellFill=a?.sellFill?.noul;
  if([buyFill,sellFill].some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1))throw new Error('Invalid fill probability');
  const tokens=body.usage?.input_tokens??body.usage?.prompt_tokens??0;
  return {action:a.action.choice,confidence:p[a.action.choice]!,moveBps:Object.entries(MOVES).reduce((s,[k,v])=>s+v*moves[k]!,0),moveDistribution:moves,buyFill,sellFill,inputTokens:Number.isSafeInteger(tokens)&&tokens>0?tokens:0,latencyMs:performance.now()-t};
 }
}
export function ruleDecision(state:ReturnType<typeof stateFor>):EnrichedDecision {
 const w30=state.windows[30] as any,w60=state.windows[60] as any,w300=state.windows[300] as any;
 const signal=(w30.returnBps??0)*.25+(w60.returnBps??0)*.1+(w300.returnBps??0)*.03+state.marketState.bookImbalance*4+(w30.flowImbalance??0)*4;
 const moveBps=Math.max(-20,Math.min(20,signal));
 return {action:Math.abs(moveBps)<4?'abstain':moveBps>0?'buy':'sell',confidence:.65,moveBps,moveDistribution:{},buyFill:.5,sellFill:.5,inputTokens:0,latencyMs:0};
}
/** Heuristic net-edge gate, NOT a calibrated expected-profit model. Both arms use it. */
export function gate(d:EnrichedDecision,state:ReturnType<typeof stateFor>,price:number,now:number,orderAt:number) {
 if(![d.moveBps,d.confidence,d.buyFill,d.sellFill,price].every(Number.isFinite))return 'invalid';
 if(state.execution.dataAgeMs>2000)return 'stale';
 if(![60,300,900].every(s=>(state.windows[s] as any)?.ready))return 'context_warming';
 if(d.action!=='buy'&&d.action!=='sell')return d.action;
 const side=d.action,size=state.execution.sizeMon,mid=state.marketState.mid;
 const after=(state.portfolio.inventoryMon+(side==='buy'?size:-size))*mid/state.portfolio.equityUsd;
 if(after<.2||after>.8)return 'inventory_limit';
 if(side==='buy'&&state.portfolio.cashUsd<size*price*(1+state.execution.exchangeFeeBps/10000)+state.execution.gasMonPerAction*mid)return 'cash_limit';
 if(side==='sell'&&state.portfolio.inventoryMon<size)return 'inventory_limit';
 if(state.portfolio.outstandingOrder&&now-orderAt<15000)return 'replace_cooldown';
 const fill=side==='buy'?d.buyFill:d.sellFill;
 if(fill<.25||d.confidence<.6)return 'low_confidence';
 const entryEdge=(side==='buy'?mid-price:price-mid)/mid*10000;
 const directional=(side==='buy'?1:-1)*d.moveBps;
 // Entry gas applies even if unfilled. Exit gas and half-spread allowance on filled notional.
 const cost=state.execution.gasBpsPerPlacement/fill+state.execution.gasBpsPerPlacement+2*state.execution.exchangeFeeBps+state.marketState.spreadBps/2+state.execution.adverseSelectionAllowanceBps;
 return directional+entryEdge>cost+state.execution.edgeBufferBps?'trade':'insufficient_edge';
}
export function cancel(a:PaperAccount,mid:number){
 if(!a.order)return false;
 a.order=null; const gas=a.costs.gasMon*mid; a.cash-=gas;a.gasUsd+=gas;return true;
}
