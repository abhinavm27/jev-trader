import {test,expect} from 'bun:test';
import {Trial} from './trial';
test('budget never resets across restart and unknown billing stays reserved',()=>{
 let t=new Trial(); expect(t.reserve()).toBe(true); t.fail();
 const reserved=t.chargedUsd; t=Object.assign(new Trial(),JSON.parse(JSON.stringify(t)));
 expect(t.chargedUsd).toBe(reserved); expect(t.unresolved).toBe(1);
 while(t.reserve()) t.settle(0,1);
 expect(t.chargedUsd).toBeLessThanOrEqual(3.5); expect(t.status()).toBe('budget_limit');
});
test('valid returned tokens release only unused reservation',()=>{
 const t=new Trial(); t.reserve(); t.settle(2000,100);
 expect(t.chargedUsd).toBeCloseTo(.000084,9); expect(t.unresolved).toBe(0);
});
test('time expiry, operator pause and failure circuit prevent new calls',()=>{
 const t=new Trial(); expect(t.reserve(t.deadline)).toBe(false);
 t.paused=true; expect(t.reserve()).toBe(false); t.paused=false;
 for(let i=0;i<5;i++){t.reserve();t.fail();}
 expect(t.status()).toBe('paused'); expect(t.reserve()).toBe(false);
});
