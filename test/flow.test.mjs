import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFlow} from '../ui/flow-state.js';

test('valid transfer conserves principal for every animation position and amount',()=>{
  for(const amount of [.01,.12,.5])for(let i=0;i<=1000;i++){
    const s=projectFlow({progress:i/1000,amount});
    assert.equal(s.accountCents+s.recipientCents,100);
    assert.ok(s.recipientCents===0||s.recipientCents===Math.round(amount*100));
    if(s.transferred)assert.equal(s.gateOpen,true);
  }
});
test('rejected proofs cannot open the gate, move principal, or seek past failure',()=>{
  for(let i=0;i<=1100;i++){
    const s=projectFlow({progress:i/1000,mode:'reject',amount:.5});
    assert.equal(s.accountCents,100);assert.equal(s.recipientCents,0);
    assert.equal(s.gateOpen,false);assert.equal(s.transferPhase,0);assert.ok(s.progress<=.5);
  }
});
test('scrubbing back from a receipt restores the starting balances and closed gate',()=>{
  const done=projectFlow({progress:1,amount:.12});
  assert.deepEqual([done.accountCents,done.recipientCents,done.payerUnits],[88,12,99]);
  const start=projectFlow({progress:0,amount:.12});
  assert.deepEqual([start.accountCents,start.recipientCents,start.payerUnits],[100,0,100]);
  assert.equal(start.gateOpen,false);assert.equal(start.transferred,false);
});
test('the simulated fee is independent of the principal on both outcomes',()=>{
  for(const mode of ['success','reject']){
    assert.equal(projectFlow({progress:.47,mode}).payerUnits,100);
    const s=projectFlow({progress:.5,mode});assert.equal(s.payerUnits,99);
    assert.equal(s.accountCents,100);assert.equal(s.recipientCents,0);
  }
});
test('non-finite and out-of-range controls cannot create invalid balances',()=>{
  const s=projectFlow({progress:NaN,amount:Infinity});
  assert.equal(s.progress,0);assert.equal(s.amountCents,12);
  assert.equal(projectFlow({progress:-1,amount:-10}).amountCents,1);
  assert.equal(projectFlow({progress:2,amount:100}).recipientCents,50);
});

test('authorization delivery precedes submission, network invocation and principal movement',()=>{
  for(const mode of ['success','reject'])for(let i=0;i<=1000;i++){
    const s=projectFlow({progress:i/1000,mode});
    if(s.submissionPhase>0)assert.equal(s.authorizationPhase,1.5);
    if(s.invokePhase>0)assert.equal(s.submissionPhase,1.5);
    if(s.transferPhase>0){assert.equal(s.invokePhase,1.5);assert.equal(s.gateOpen,true);assert.equal(s.feePaid,true);}
    if(s.receiptPhase>0&&mode==='success')assert.equal(s.transferred,true);
  }
});
test('both outcomes return a receipt; a failure receipt cannot indicate a principal transfer',()=>{
  const good=projectFlow({progress:1});assert.equal(good.receiptReady,true);assert.equal(good.transferred,true);
  const bad=projectFlow({progress:1,mode:'reject'});
  assert.equal(bad.receiptReady,true);assert.equal(bad.rejected,true);assert.equal(bad.gateOpen,false);
  assert.deepEqual([bad.accountCents,bad.recipientCents,bad.payerUnits],[100,0,99]);
  const rewind=projectFlow({progress:0,mode:'reject'});assert.equal(rewind.receiptReady,false);assert.equal(rewind.receiptPhase,0);
});
