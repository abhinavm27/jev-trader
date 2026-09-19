import { test, expect } from 'bun:test';
import { PaperAccount } from './paper';
const costs = { gasMon:0, feeBps:0, participation:1 };
test('no fill before arrival or on a mere touch; partial fills bounded by volume', () => {
  const a = new PaperAccount(100, 1, {...costs, participation:0.1});
  a.quote('buy', 1, 10, 3, 1);
  expect(a.consume({block:3, side:'sell', price:0.99,size:100})).toBe(0);
  expect(a.consume({block:4, side:'sell', price:1,size:100})).toBe(0);
  expect(a.consume({block:4, side:'sell', price:0.99,size:20})).toBe(2);
  expect(a.order?.remaining).toBe(8);
});
test('round trip reconciles gross profit, gas, fees and equity', () => {
  const a = new PaperAccount(100, 1, {gasMon:0.1,feeBps:100,participation:1});
  a.quote('buy',1,10,1,1); a.consume({block:2,price:0.99,side:'sell',size:10});
  a.quote('sell',1.1,10,2,1); a.consume({block:3,price:1.11,side:'buy',size:10});
  const m=a.metrics(1);
  expect(m.grossTradingPnlUsd).toBeCloseTo(1);
  expect(m.estimatedGasUsd).toBeCloseTo(0.2);
  expect(m.estimatedExchangeFeesUsd).toBeCloseTo(0.21);
  expect(m.netBeforeHostingUsd).toBeCloseTo(0.59);
  expect(m.realizedGrossUsd + m.unrealizedGrossUsd).toBeCloseTo(m.grossTradingPnlUsd);
});
test('retaining an identical order does not incur a second gas charge',()=>{
 const a=new PaperAccount(100,1,{...costs,gasMon:0.1});
 expect(a.quote('buy',1,10,1,1)).toBe(true);
 expect(a.quote('buy',1,10,2,1)).toBe(false);
 expect(a.orders).toBe(1);expect(a.gasUsd).toBe(0.1);
});
test('cash and inventory limits prevent unfunded trades',()=>{
 const a=new PaperAccount(100,1,costs);
 expect(a.quote('buy',1,51,1,1)).toBe(false);
 expect(a.quote('sell',1,51,1,1)).toBe(false);
 expect(a.orders).toBe(0);
});
test('buy-and-hold benchmark matches initial allocation; drawdown uses running peak',()=>{
 const a=new PaperAccount(100,1,costs);
 expect(a.metrics(1.2).holdPnlUsd).toBeCloseTo(10);
 const m=a.metrics(0.8);expect(m.excessVsHoldUsd).toBeCloseTo(0);
 expect(m.maxDrawdownUsd).toBeCloseTo(20);
});
