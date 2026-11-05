import test from 'node:test';
import assert from 'node:assert/strict';
import {testIdentitySeeds,testActiveSeeds,TestSigningSession,hex} from '../ui/test-wallet-core.js';
import {CHAIN_SLOTS,EvmTreeKey,leafPk,rootFromProof} from '../ui/lib/evmwots.js';
import {validateDemoReport,validateDemoReceipt,DEMO_STAGES} from '../ui/local-demo.js';
import {accountCodeHash} from '../ui/contract-pin.js';
const master=new Uint8Array(32).fill(7),walletId=new Uint8Array(16).fill(9);
const account='0x'+'11'.repeat(20),pub=new Uint8Array(16).fill(3),digest=new Uint8Array(16).fill(4);
test('BSC testnet has a distinct slot; existing slots are not renumbered',()=>{
  assert.equal(CHAIN_SLOTS[97],8);assert.equal(CHAIN_SLOTS[31337],2);
  assert.equal(new Set(Object.values(CHAIN_SLOTS)).size,Object.keys(CHAIN_SLOTS).length);
});
test('identity derivation separates networks and wallet instances',()=>{
  const a=testIdentitySeeds(master,97,walletId);
  assert.notEqual(hex(a.skSeed),hex(testIdentitySeeds(master,31337,walletId).skSeed));
  assert.notEqual(hex(a.pubSeed),hex(testIdentitySeeds(master,97,new Uint8Array(16)).pubSeed));
  assert.throws(()=>testIdentitySeeds(master,56,walletId));
  assert.throws(()=>testIdentitySeeds(new Uint8Array(16),97,walletId));
});
test('active derivation separates account, epoch, chain and public seed',()=>{
  const a=testActiveSeeds(master,97,account,1,pub);
  for(const args of [[31337,account,1,pub],[97,'0x'+'22'.repeat(20),1,pub],[97,account,2,pub],[97,account,1,new Uint8Array(16)]]){
    assert.notEqual(hex(a.skSeed),hex(testActiveSeeds(master,...args).skSeed));
  }
  assert.throws(()=>testActiveSeeds(master,56,account,1,pub));
});
// Only leaf 0 is a real WOTS leaf in this small test fixture. Other leaves are
// opaque siblings; full 1024-leaf generation is exercised by local-demo.mjs.
const leaves=Array.from({length:1024},()=>new Uint8Array(16));leaves[0]=leafPk(master,pub,0);
const tree=new EvmTreeKey(master,pub,leaves);
test('signature is withheld until reservation completes; concurrent reuse is rejected',async()=>{
  let release,record;
  const session=new TestSigningSession(r=>{record=r;return new Promise(resolve=>release=resolve);});
  let completed=false;const pending=session.sign(tree,0,digest).then(p=>{completed=true;return p;});
  await Promise.resolve();assert.equal(completed,false);assert.equal(record.leaf,0);
  await assert.rejects(session.sign(tree,0,new Uint8Array(16)),/已预留/);
  release();const proof=await pending;
  assert.equal(hex(rootFromProof(pub,0,digest,proof)),hex(tree.root));
  await assert.rejects(session.sign(tree,0,digest),/已预留/);
});
test('failed durable reservation burns the in-process slot without signing',async()=>{
  let signed=false;const guarded={...tree,sign(){signed=true;return tree.sign(0,digest);}};
  const session=new TestSigningSession(()=>{throw new Error('disk unavailable');});
  await assert.rejects(session.sign(guarded,0,digest),/disk/);assert.equal(signed,false);
  await assert.rejects(session.sign(guarded,0,digest),/已预留/);
});
test('bad leaf and malformed digest are rejected before reservation',async()=>{
  let reservations=0;const session=new TestSigningSession(()=>reservations++);
  await assert.rejects(session.sign(tree,1024,digest));await assert.rejects(session.sign(tree,0,new Uint8Array(15)));
  assert.equal(reservations,0);
});
const payer='0x'+'33'.repeat(20),hash='0x'+'ab'.repeat(32),blockHash='0x'+'cd'.repeat(32);
const report={format:'aurven-local-demo-v1',runId:'aa'.repeat(16),chainId:31337,publicTestKeys:true,
  account,payer,recipient:'0x'+'22'.repeat(20),codeHash:accountCodeHash,
  steps:DEMO_STAGES.map(([stage],i)=>({stage,hash:'0x'+i.toString(16).padStart(64,'0'),blockHash,blockNumber:'0x1',from:payer,
    to:i===0?null:account,contractAddress:i===0?account:null,valueWei:'0',gasUsed:'10',gasPriceWei:'2',feeWei:'20'}))};
test('manifest rejects mainnet, altered costs and duplicate transaction rows',()=>{
  assert.equal(validateDemoReport(report),report);
  assert.throws(()=>validateDemoReport({...report,chainId:56}));
  const wrong=structuredClone(report);wrong.steps[1].feeWei='1';assert.throws(()=>validateDemoReport(wrong));
  const duplicate=structuredClone(report);duplicate.steps[1].hash=duplicate.steps[0].hash;assert.throws(()=>validateDemoReport(duplicate));
});
const step={...report.steps[3],hash};
const receipt={status:'0x1',transactionHash:hash,blockHash,blockNumber:'0x1',from:payer,to:account,gasUsed:'0xa',effectiveGasPrice:'0x2'};
const tx={hash,blockHash,blockNumber:'0x1',from:payer,to:account,value:'0x0'};
const block={number:'0x1',hash:blockHash,timestamp:'0x6b49d200'};
test('receipt validation rejects revert, reorg, replaced transaction and wrong payer',()=>{
  assert.equal(validateDemoReceipt(step,receipt,tx,block,report).verified,true);
  for(const changed of [{...receipt,status:'0x0'},{...receipt,from:account},{...receipt,gasUsed:'0xb'},{...receipt,transactionHash:blockHash}]){
    assert.throws(()=>validateDemoReceipt(step,changed,tx,block,report));
  }
  assert.throws(()=>validateDemoReceipt(step,receipt,{...tx,to:payer},block,report));
  assert.throws(()=>validateDemoReceipt(step,receipt,tx,{...block,hash},report));
  assert.throws(()=>validateDemoReceipt(step,null,tx,block,report));
});
