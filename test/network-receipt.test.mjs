import test from 'node:test';
import assert from 'node:assert/strict';
import {networkReceipt,reconcileNetwork,retainNetworkHistory} from '../ui/network-account.js';

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
  t.mock.method(globalThis,'fetch',async (_url,options)=>{
    const {id,method,params}=JSON.parse(options.body);
    const result=await respond(method,params);
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
