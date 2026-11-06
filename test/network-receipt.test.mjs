import test from 'node:test';
import assert from 'node:assert/strict';
import {networkReceipt,reconcileNetwork,retainNetworkHistory} from '../ui/network-account.js';

import {compareNetworkReceipts,digestData} from '../ui/network-receipt.js';

const endpoint='http://127.0.0.1:1',payer='0x'+'12'.repeat(20),hash='0x'+'ab'.repeat(32);
const headHash='0x'+'cd'.repeat(32),otherHash='0x'+'ef'.repeat(32);
const base={id:'send',status:'waiting',payer,nonce:'0x2',startBlock:'0x1',hash,kind:'send',
  deadline:Math.floor(Date.now()/1000)-10,dataHash:hash};
function missing(method,params) {
  if(method==='eth_chainId')return '0x61';
  if(method==='eth_getTransactionByHash')return null;
  if(method==='eth_getTransactionCount')return '0x2';
  assert.equal(method,'eth_getBlockByNumber');
  const number=params[0]==='latest'?'0x4':params[0];
  return {number,hash:headHash,timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[]};
}
function mockRpc(t,respond) {
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const {id,method,params}=JSON.parse(options.body);
    const result=await respond(method,params,url);
    return Response.json({jsonrpc:'2.0',id,result});
  });
}
test('elapsed signed approval, unseen payment and funding without an on-chain deadline are distinct',async t=>{
  mockRpc(t,missing);
  assert.equal((await networkReceipt(endpoint,base)).status,'expired');
  const fund={...base,kind:'fund'};
  assert.equal((await networkReceipt(endpoint,fund)).status,'unseen');
  assert.equal((await networkReceipt(endpoint,{...base,deadline:base.deadline+600})).status,'unseen');
  assert.throws(()=>retainNetworkHistory([{...fund,status:'unseen'}],{...fund,id:'second'}),/TRIAL_IN_USE/);
  await assert.rejects(networkReceipt(endpoint,base,otherHash),/TRIAL_HASH/);
});
test('an unconfirmed or missing RPC response cannot establish a reorganization or a replacement',async t=>{
  let mode='same';
  mockRpc(t,(m,p)=>{
    const data=missing(m,p);
    if (m==='eth_getBlockByNumber' && p[0]==='0x2' && mode==='same') return {...data,transactions:[hash]};
    if (m==='eth_getBlockByNumber' && p[0]==='0x4' && mode==='moving') return {...data,hash:otherHash};
    if (m==='eth_getTransactionCount' && mode==='pruned') return '0x3';
    return data;
  });
  const legacy={...base,status:'included',block:'0x2'};
  await assert.rejects(networkReceipt(endpoint,legacy),/NET_UNVERIFIED/);
  assert.equal((await networkReceipt(endpoint,{...base,status:'included',block:'0x3'})).status,'reorg');
  await assert.rejects(networkReceipt(endpoint,{...legacy,block:'0x5'}),/NET_UNVERIFIED/);
  mode='moving';await assert.rejects(networkReceipt(endpoint,base),/NET_UNVERIFIED/);
  mode='pruned';await assert.rejects(networkReceipt(endpoint,base),/NET_UNVERIFIED/);
});
test('a late tab cannot overwrite a newer stored observation',async t=>{
  let entered,resume;
  const started=new Promise(r=>{entered=r;});
  const paused=new Promise(r=>{resume=r;});
  let delay=true;
  mockRpc(t,async(m,p)=>{
    if(m==='eth_chainId' && delay){delay=false;entered();await paused;}
    return missing(m,p);
  });
  let state={rows:[{...base}]};
  const store={read:async()=>structuredClone(state),compareAndSwap:async(old,next)=>{
    assert.deepEqual(old,state);state=structuredClone(next);
  }};
  const late=reconcileNetwork(store,endpoint,base.id);
  await started;
  const latest=await reconcileNetwork(store,endpoint,base.id);
  resume();await assert.rejects(late,/NET_CHECK_AGAIN/);
  assert.deepEqual(state.rows[0],latest);
  assert.equal(latest.status,'expired');
});

const secondary='http://127.0.0.1:2';
const fixedTime='0x'+Math.floor(Date.now()/1000).toString(16);
function stableMissing(method,params) {
  const result=missing(method,params);
  return method==='eth_getBlockByNumber'?{...result,timestamp:fixedTime}:result;
}
function recordStore(row) {
  let state={rows:[structuredClone(row)]};
  return {read:async()=>structuredClone(state),compareAndSwap:async(old,next)=>{
    assert.deepEqual(old,state);state=structuredClone(next);
  }};
}
test('two different heads agree only at the common block, and a fork there blocks the update',async t=>{
  let fork=false;
  const reads=[];
  mockRpc(t,(method,params,url)=>{
    reads.push([url,method,...params]);
    const result=stableMissing(method,params);
    if(method!=='eth_getBlockByNumber'||!url.startsWith(secondary))return result;
    if(params[0]==='latest')return {...result,number:'0x6',hash:otherHash};
    return fork?{...result,hash:otherHash}:result;
  });
  const store=recordStore(base);
  const run=()=>reconcileNetwork(store,endpoint,base.id,undefined,secondary);
  const agreed=await run();
  assert.equal(agreed.checkedBlock,'0x4');assert.equal(agreed.checkedBlockHash,headHash);
  assert.deepEqual(agreed.receiptCheck,{kind:'agreed',block:'0x4'});
  assert.ok(reads.some(([url,method,,tag])=>url.startsWith(secondary)&&method==='eth_getTransactionCount'&&tag==='0x4'));
  fork=true;
  const conflict=await run();
  assert.deepEqual(conflict.receiptCheck,{kind:'conflict',reason:'block',block:'0x4'});
  assert.equal(conflict.status,agreed.status);assert.equal(conflict.checkedBlockHash,agreed.checkedBlockHash);
  const creation={...conflict,kind:'create',account:payer,walletId:'sample',status:'included'};
  assert.throws(()=>retainNetworkHistory([creation],{kind:'send',account:payer,walletId:'sample'}),/NET_ACCOUNT_CHECK/);
});
test('outages, wrong network and restricted history never promote one source to an agreed receipt',async t=>{
  let mode='primary down';
  mockRpc(t,(method,params,url)=>{
    const peer=url.startsWith(secondary);
    if (mode==='both down' || (!peer && mode==='primary down') || (peer && mode==='secondary down')) throw new TypeError('offline');
    if (peer && mode==='wrong chain' && method==='eth_chainId')return '0x38';
    if (peer && mode==='history unavailable' && method==='eth_getTransactionCount')throw new Error('pruned');
    return stableMissing(method,params);
  });
  const store=recordStore(base);
  const run=()=>reconcileNetwork(store,endpoint,base.id,undefined,secondary);
  for (const [scenario,source] of [['primary down','secondary'],['secondary down','primary'],['wrong chain','primary'],['history unavailable','primary']]) {
    mode=scenario;const row=await run();
    assert.deepEqual(row.receiptCheck,{kind:'single',source,block:'0x4',status:'expired'});
    assert.equal(row.status,'waiting');assert.equal(row.checkedBlock,undefined);
  }
  mode='both down';assert.deepEqual((await run()).receiptCheck,{kind:'unavailable'});
  mode='healthy';assert.equal((await run()).status,'expired');
  await assert.rejects(compareNetworkReceipts(endpoint,endpoint+'/',base),/NET_SOURCES/);
});
test('a replacement at different inclusion blocks is a disagreement even when both nodes name the same replacement hash',async t=>{
  const row={...base,account:payer,kind:'fund',value:'0x3',dataHash:digestData('0x')};
  const replacement={hash,chainId:'0x61',nonce:row.nonce,from:payer,to:payer,value:'0x1',input:'0x',blockNumber:'0x2'};
  const blockAtTwo='0x'+'23'.repeat(32);
  let separated=true;
  mockRpc(t,(method,params,url)=>{
    const different=separated && url.startsWith(secondary),blockHash=different?otherHash:blockAtTwo;
    if (method==='eth_getTransactionByHash')return {...replacement,blockHash};
    if (method==='eth_getTransactionReceipt')return {transactionHash:hash,blockNumber:'0x2',blockHash,from:payer,to:payer,status:'0x1'};
    if (method==='eth_getBlockByNumber' && params[0]==='0x2')return {...stableMissing(method,params),hash:blockHash,transactions:[hash]};
    return stableMissing(method,params);
  });
  const store=recordStore(row),run=()=>reconcileNetwork(store,endpoint,row.id,undefined,secondary);
  const conflict=await run();
  assert.equal(conflict.receiptCheck.kind,'conflict');assert.equal(conflict.receiptCheck.reason,'observation');
  assert.equal(conflict.status,row.status);assert.equal(conflict.replacementHash,undefined);
  separated=false;const resolved=await run();
  assert.equal(resolved.receiptCheck.kind,'agreed');assert.equal(resolved.status,'replaced');
  assert.equal(resolved.replacementBlockHash,blockAtTwo);
});
test('pending visibility can differ by node and cannot overwrite the saved state or free the payer nonce',async t=>{
  const row={...base,kind:'fund',account:payer,value:'0x3',dataHash:digestData('0x')};
  mockRpc(t,(m,p,url)=>{
    if(m==='eth_getTransactionByHash' && url.startsWith(secondary))return {
      from:payer,to:payer,nonce:row.nonce,hash,chainId:'0x61',input:'0x',value:'0x3',blockHash:null,blockNumber:null};
    return stableMissing(m,p);
  });
  const r=await reconcileNetwork(recordStore(row),endpoint,row.id,undefined,secondary);
  assert.equal(r.receiptCheck.reason,'observation');assert.equal(r.status,'waiting');
  assert.deepEqual([r.receiptCheck.primary,r.receiptCheck.secondary],['unseen','pending']);
  assert.throws(()=>retainNetworkHistory([r],{...row,id:'new'}),/TRIAL_IN_USE/);
});

test('a nonce that moves ahead of the transaction index triggers one read-only retry with fresh heads',async t=>{
  let heads=0;
  mockRpc(t,(method,params,url)=>{
    if (method==='eth_getBlockByNumber' && params[0]==='latest' && url.startsWith(secondary)) heads++;
    if (method==='eth_getTransactionCount' && url.startsWith(secondary) && heads===1) return '0x3';
    return stableMissing(method,params);
  });
  const {check,observation}=await compareNetworkReceipts(endpoint,secondary,base);
  assert.equal(heads,2);assert.equal(check.kind,'agreed');assert.equal(observation.status,'expired');
});
