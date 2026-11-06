import test from 'node:test';
import assert from 'node:assert/strict';
import {rootFromProof,PROOF_LEN} from '../ui/lib/evmwots.js';
import {retainNetworkHistory} from '../ui/network-account.js';
import {TestVault} from '../ui/vault-service.js';
import {decryptPayload,validateOffer,validateTestnetOffer} from '../ui/vault-crypto.js';
import {handoverFingerprint,matchOffer,networkHasher,validateNetworkPlan} from '../ui/vault-network-proof.js';
import {accountCodeHash} from '../ui/contract-pin.js';
import {hex} from '../ui/test-wallet-core.js';

const part=n=>'0x'+n.repeat(32),account='0x'+'12'.repeat(20),payer='0x'+'34'.repeat(20);
const snapshot={account,chainId:97,codeHash:accountCodeHash,pubSeed:part('1'),root:part('2'),epoch:4,next:2,
  blockNumber:'0x30',blockHash:'0x'+'ab'.repeat(32),timestamp:Math.floor(Date.now()/1000)};
const offer={format:'aurven-testnet-handover-v1',chainId:97,account,epoch:4,oldSeed:snapshot.pubSeed,oldRoot:snapshot.root,
  newSeed:part('3'),newRoot:part('4'),deadline:snapshot.timestamp+1000};
const rotation={chainId:97,account,payer,recipient:payer,kind:'rotate',snapshot,value:'0x0',offer,
  fingerprint:handoverFingerprint(offer),deadline:offer.deadline};

test('a handover binds chain, account, source epoch, successor keys, deadline and independently entered fingerprint',()=>{
  validateNetworkPlan(rotation);
  assert.throws(()=>validateTestnetOffer({...offer,chainId:56}),/HANDOVER_OFFER/);
  assert.throws(()=>validateOffer(offer),/HANDOVER_OFFER/);
  for(const fields of [{fingerprint:'0'.repeat(32)},{kind:'send'},{deadline:offer.deadline+1},
    {snapshot:{...snapshot,epoch:3}},{snapshot:{...snapshot,root:part('9')}},{offer:{...offer,newRoot:part('5')}}]){
    assert.throws(()=>validateNetworkPlan({...rotation,...fields}),/HANDOVER_OFFER/);
  }
  matchOffer(offer,{...offer});
  for(const field of ['account','chainId','epoch','oldSeed','oldRoot','newSeed','newRoot','deadline']){
    assert.throws(()=>matchOffer(offer,{...offer,[field]:null}),/HANDOVER_OFFER/);
  }
});

test('history pressure preserves a public handover record after confirmation or a lost reply',()=>{
  const handover={kind:'rotate',offer,dataHash:'0x'+'ab'.repeat(32),status:'included'};
  const ordinary=Array.from({length:31},(_,i)=>({kind:'send',status:'included',id:i}));
  for(const status of ['included','waiting','replaced','reverted']){
    const record={...handover,status,nonce:'0x1',payer};
    const rows=retainNetworkHistory([record,...ordinary],{kind:'send',payer,nonce:'0x2',account});
    assert.equal(rows.length,31);assert.equal(rows[0],record);
  }
});

function fixture(options){
  let record;
  const store={name:'test-device',read:async()=>record,create:async r=>{record=r;},
    compareAndSwap:async(old,next)=>{assert.equal(record,old);record=next;}};
  const vault=new TestVault(store,{locks:{request:(_name,_opts,fn)=>fn({})},networkPreflight:async()=>{},...options});
  return {vault,store};
}
test('reserving a handover retires the source tree even if signing is interrupted and the vault reopens',async t=>{
  let signCalls=0,wrongTarget=true;
  const {vault,store}=fixture({networkWorkerFactory:()=>({
    dispose(){},async request(type,{plan,leaf,key}){
      if(type==='sign'){signCalls++;throw new Error('stop after commit');}
      const intent={leaf,seed:offer.oldSeed.slice(2),root:offer.oldRoot.slice(2),newSeed:offer.newSeed.slice(2),
        newRoot:wrongTarget?part('9').slice(2):offer.newRoot.slice(2),rnd:'ef'.repeat(16),salt:0};
      assert.equal((await decryptPayload(await store.read(),key)).journal.length,0);
      return {...intent,digest:hex(networkHasher(plan,intent)(0))};
    }})});
  t.after(()=>vault.lock());const password=crypto.randomUUID();const {walletId}=await vault.create(password,97);
  const plan={...rotation,walletId};
  await assert.rejects(vault.authorizeNetworkAction(plan,undefined,()=>assert.fail()),/HANDOVER_OFFER/);assert.equal(vault.details.reservations,0);
  wrongTarget=false;
  await assert.rejects(vault.authorizeNetworkAction(plan,undefined,()=>assert.fail()),/stop after commit/);assert.equal(vault.details.reservations,1);
  vault.lock();await vault.unlock(password);
  for(const kind of ['send','rotate']){
    const {offer:_,fingerprint:__,...ordinary}=plan;
    await assert.rejects(vault.authorizeNetworkAction({...ordinary,kind}),/HANDOVER_RETIRED/);
  }
  assert.equal(signCalls,1);
});

test('the receiver persists one public request, blocks signing before admission and refuses restored vaults',async t=>{
  let calls=0;
  const {vault}=fixture({recoveryReader:async({account:target,tag})=>{
    assert.equal(tag,'finalized');assert.equal(target,account);return snapshot;},
    bindingWorkerFactory:()=>({dispose(){},async request(_type,{record,snapshot:s}){
      calls++;return {walletId:record.walletId,chainId:97,account,epoch:s.epoch,pubSeed:s.pubSeed,root:part('8')};}})});
  t.after(()=>vault.lock());const password=crypto.randomUUID();const {walletId}=await vault.create(password,97);
  const previous=await vault.exportBackup();
  const request=await vault.prepareTestnetHandover(account);
  assert.equal((await vault.checkBackupFile(previous)).status,'older');
  assert.notEqual(request.newRoot,request.oldRoot);assert.equal(vault.receivedAccount,null);
  vault.lock();await vault.unlock(password);
  assert.deepEqual(await vault.prepareTestnetHandover(account),request);assert.equal(calls,2);
  await assert.rejects(vault.prepareTestnetHandover(payer),/HANDOVER_FRESH/);
  await assert.rejects(vault.authorizeNetworkAction({...rotation,walletId,kind:'send',offer:undefined}),/HANDOVER_PENDING/);
  const {vault:copy}=fixture({});t.after(()=>copy.lock());
  await copy.restoreBackup(await vault.exportBackup(),password);
  assert.equal(copy.receivedAccount,null);await assert.rejects(copy.prepareTestnetHandover(account),/RECOVERY/);
});

test('an interrupted payment reopens only the original authenticated bytes after unlock',async t=>{
  const proof=crypto.getRandomValues(new Uint8Array(PROOF_LEN));
  const intent={leaf:960,seed:rotation.offer.oldSeed.slice(2),newSeed:rotation.offer.newSeed.slice(2),
    newRoot:rotation.offer.newRoot.slice(2),salt:1,rnd:'b3'.repeat(16)};
  const digest=networkHasher(rotation,intent)(intent.salt);
  intent.digest=hex(digest);
  intent.root=hex(rootFromProof(Buffer.from(intent.seed,'hex'),intent.leaf,digest,proof));
  const updatedOffer={...rotation.offer,oldRoot:'0x'+intent.root};
  let signs=0,saved,failFinalCheck=true;
  const {vault}=fixture({networkPreflight:async()=>{if(saved&&failFinalCheck)throw Error('interrupted after save');},
    networkWorkerFactory:()=>({dispose(){},async request(type){
      if(type==='prepare')return intent;
      signs++;return proof.slice();
    }})});
  t.after(()=>vault.lock());const password=crypto.randomUUID();const {walletId}=await vault.create(password,97);
  const plan={...rotation,id:crypto.randomUUID(),walletId,offer:updatedOffer,nonce:'0x3',gas:'0xaae60',gasPrice:'0x2',
    snapshot:{...rotation.snapshot,root:updatedOffer.oldRoot},startBlock:'0x30',
    reviewBlock:{number:snapshot.blockNumber,hash:snapshot.blockHash},fingerprint:handoverFingerprint(updatedOffer)};
  await assert.rejects(vault.authorizeNetworkAction(plan),/RETRY_MISSING/);
  assert.equal(vault.details.reservations,0);
  await assert.rejects(vault.authorizeNetworkAction(plan,undefined,async entry=>{saved={...plan,...entry};}),/interrupted after save/);
  assert.equal(signs,1);assert.equal(vault.details.reservations,1);
  vault.lock();await assert.rejects(vault.readHandoverPayment(saved),/LOCKED/);await vault.unlock(password);
  const original=await vault.readHandoverPayment(saved);assert.ok(original.endsWith(hex(proof)));
  assert.ok(!JSON.stringify(saved).includes(original.slice(2)));
  for(const changed of [{gasPrice:'0x3'},{nonce:'0x4'},{id:crypto.randomUUID()},{payer:account,recipient:account},
    {reviewBlock:{...plan.reviewBlock,number:'0x31'}},{dataHash:'0x'+'ff'.repeat(32)},
    {escrow:{...saved.escrow,cipher:(saved.escrow.cipher[0]==='0'?'1':'0')+saved.escrow.cipher.slice(1)}}]){
    await assert.rejects(vault.readHandoverPayment({...saved,...changed}),/RETRY_INVALID/);
  }
  await assert.rejects(vault.readHandoverPayment({...saved,deadline:1}),/TRIAL_CLOCK/);
  await assert.rejects(vault.readHandoverPayment({...saved,escrow:null}),/RETRY_MISSING/);
  const {vault:copy}=fixture({});t.after(()=>copy.lock());await copy.restoreBackup(await vault.exportBackup(),password);
  await assert.rejects(copy.readHandoverPayment(saved),/RECOVERY/);
  failFinalCheck=false;assert.equal(await vault.readHandoverPayment(saved),original);
  assert.equal(signs,1);assert.equal(vault.details.reservations,1);
});

test('a failed signed-payment save burns the leaf without releasing an authorization',async t=>{
  const proof=new Uint8Array(PROOF_LEN);
  const intent={leaf:960,seed:offer.oldSeed.slice(2),newSeed:offer.newSeed.slice(2),newRoot:offer.newRoot.slice(2),salt:0,rnd:'cd'.repeat(16)};
  const digest=networkHasher(rotation,intent)(0);intent.digest=hex(digest);
  intent.root=hex(rootFromProof(Buffer.from(intent.seed,'hex'),960,digest,proof));
  const target={...offer,oldRoot:'0x'+intent.root};
  const {vault}=fixture({networkWorkerFactory:()=>({dispose(){},request:async type=>type==='sign'?proof.slice():intent})});
  t.after(()=>vault.lock());const {walletId}=await vault.create(crypto.randomUUID(),97);
  const plan={...rotation,walletId,offer:target,snapshot:{...snapshot,root:target.oldRoot},fingerprint:handoverFingerprint(target)};
  const save=async()=>{throw Error('storage failed');};
  await assert.rejects(vault.authorizeNetworkAction(plan,undefined,save),e=>e.message==='storage failed' && e.leafReserved);
  await assert.rejects(vault.authorizeNetworkAction(plan,undefined,save),/HANDOVER_RETIRED/);
  assert.equal(vault.details.reservations,1);
});
