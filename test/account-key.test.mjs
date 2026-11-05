import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createEnvelope,decryptPayload,encryptPayload,hex,VaultError} from '../ui/vault-crypto.js';
import {deriveAccountRoot} from '../ui/account-key-engine.js';
import {validateKeySnapshot} from '../ui/account-key-check.js';
import {TestVault} from '../ui/vault-service.js';
import {accountCodeHash} from '../ui/contract-pin.js';
import {testIdentitySeeds,testActiveSeeds} from '../ui/test-wallet-core.js';
import {fromHex} from '../ui/local-proof.js';
import {EvmTreeKey,leafPk} from '../ui/lib/evmwots.js';

const password='Disposable account root check fixture';
const base=await createEnvelope(password,31337),account='0x'+'11'.repeat(20);
const snapshot={account,chainId:31337,epoch:1,next:0,pubSeed:'0x'+'22'.repeat(16),root:'0x'+'33'.repeat(16),
  blockNumber:'0x1',blockHash:'0x'+'44'.repeat(32),timestamp:Math.floor(Date.now()/1000),codeHash:accountCodeHash};
const code=value=>error=>error.code===value;
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function partialTree(sk,pub,progress){const leaves=Array.from({length:1024},()=>new Uint8Array(16));leaves[0]=leafPk(sk,pub,0);progress?.(1);return new EvmTreeKey(sk,pub,leaves);}
class Store{
  name='aurven-account-key-fixture';record=structuredClone(base.record);
  async read(){if(this.beforeRead)await this.beforeRead();return structuredClone(this.record);}
  async compareAndSwap(){assert.fail('Read-only checks must never save vault data');}
}
class Client{
  disposed=false;calls=[];
  async request(type,payload,progress){this.calls.push(type);if(this.beforeRequest)await this.beforeRequest();
    if(this.disposed)throw new VaultError('CANCELED');
    return deriveAccountRoot(payload,progress,partialTree);}
  dispose(){this.disposed=true;}
}
async function setup({store=new Store(),client=new Client(),change=()=>{}}={}){
  const derived=await deriveAccountRoot({record:store.record,key:base.key,snapshot},null,partialTree);
  let reads=0;const reader=async args=>{
    assert.equal(args.chainId,31337);assert.equal(args.account,account);assert.ok(args.signal);
    const current={...snapshot,root:derived.root};reads++;await change(current,reads);return current;
  };
  const vault=new TestVault(store,{locks:{request:async(name,options,action)=>action({name})},accountReader:reader,bindingWorkerFactory:()=>client});
  await vault.unlock(password);return {vault,store,client,reads:()=>reads};
}
const request={account,endpoint:'https://example.test/disposable-provider-marker'};

test('root check validates pinned contract, test network and complete snapshot context',()=>{
  assert.equal(validateKeySnapshot(snapshot,31337,account).account,account);
  for(const change of [{chainId:56},{codeHash:'0x'+'ff'.repeat(32)},{next:1025},{epoch:-1},{root:'0x12'},{timestamp:1}])
    assert.throws(()=>validateKeySnapshot({...snapshot,...change},31337,account),code('KEY_CONTEXT'));
});
test('epoch zero uses identity derivation, not the active or self-check domain',async()=>{
  const payload=await decryptPayload(base.record,base.key),master=fromHex(payload.seed);
  const seeds=testIdentitySeeds(master,31337,fromHex(base.record.walletId)),expected=partialTree(seeds.skSeed,seeds.pubSeed);
  const result=await deriveAccountRoot({record:base.record,key:base.key,snapshot:{...snapshot,epoch:0}},null,partialTree);
  assert.equal(result.root,'0x'+hex(expected.root));assert.equal(result.pubSeed,'0x'+hex(expected.pubSeed));master.fill(0);expected.skSeed.fill(0);
});
test('active derivation binds account, network, epoch and public seed; temporary key bytes are cleared',async()=>{
  const payload=await decryptPayload(base.record,base.key),master=fromHex(payload.seed);
  const seeds=testActiveSeeds(master,31337,account,1,fromHex(snapshot.pubSeed.slice(2)));
  let captured;
  const result=await deriveAccountRoot({record:base.record,key:base.key,snapshot},null,(sk,pub)=>{
    assert.equal(hex(sk),hex(seeds.skSeed));captured=sk;return partialTree(sk,pub);
  });
  assert.ok(captured.every(value=>value===0));assert.equal(result.pubSeed,snapshot.pubSeed);assert.notEqual(result.root,snapshot.root);
  master.fill(0);seeds.skSeed.fill(0);
});
test('successful comparison reads twice, returns only public evidence and never mutates the vault',async()=>{
  const {vault,store,client,reads}=await setup(),original=structuredClone(store.record);
  const result=await vault.checkAccountKeys(request);assert.equal(result.matched,true);assert.equal(reads(),2);assert.deepEqual(store.record,original);
  assert.equal(vault.details.reservations,0);assert.equal(client.disposed,true);assert.deepEqual(client.calls,['check']);
  assert.doesNotMatch(JSON.stringify(result),/disposable-provider-marker|"seed"|"key"|"password"/);vault.lock();assert.equal(vault.accountCheck,null);
});
test('a root mismatch is a negative result, never a signing permission',async()=>{
  const {vault}=await setup({change:state=>{state.root=snapshot.root;}});
  assert.equal((await vault.checkAccountKeys(request)).matched,false);assert.equal(vault.details.reservations,0);vault.lock();
});
test('changed root, epoch, public seed or next leaf during calculation invalidates the result',async()=>{
  for(const change of [{root:snapshot.root},{epoch:2},{pubSeed:'0x'+'ff'.repeat(16)},{next:1}]){
    const {vault}=await setup({change:(state,count)=>{if(count===2)Object.assign(state,change);}});
    await assert.rejects(vault.checkAccountKeys(request),code('ACCOUNT_CHANGED'));assert.equal(vault.accountCheck,null);vault.lock();
  }
});
test('read-only recovery may compare roots but remains unable to reserve or sign',async()=>{
  const store=new Store();store.record=await encryptPayload(await decryptPayload(base.record,base.key),base.key,{...base.record,mode:'recovery-readonly'});
  const {vault}=await setup({store});assert.equal((await vault.checkAccountKeys(request)).matched,true);
  assert.equal(vault.details.mode,'recovery-readonly');assert.equal(vault.details.reservations,0);
  await assert.rejects(vault.buildProofTree(),code('RECOVERY'));vault.lock();
});
test('locking during an RPC read prevents late worker start and clears results',async()=>{
  const entered=deferred(),gate=deferred();const {vault,client}=await setup({change:async()=>{entered.resolve();await gate.promise;}});
  const pending=vault.checkAccountKeys(request);await entered.promise;vault.lock();gate.resolve();
  await assert.rejects(pending,code('LOCKED'));assert.deepEqual(client.calls,[]);assert.equal(vault.accountCheck,null);
});
test('canceling a running worker discards the result without modifying reservations',async()=>{
  const client=new Client(),entered=deferred(),gate=deferred();client.beforeRequest=()=>{entered.resolve();return gate.promise;};
  const {vault,store}=await setup({client}),original=structuredClone(store.record);
  const pending=vault.checkAccountKeys(request);await entered.promise;vault.cancelAccountCheck();gate.resolve();
  await assert.rejects(pending,code('CANCELED'));assert.equal(client.disposed,true);assert.deepEqual(store.record,original);assert.equal(vault.accountCheck,null);vault.lock();
});
test('concurrent root checks cannot overwrite one another',async()=>{
  const entered=deferred(),gate=deferred();const {vault}=await setup({change:async(state,count)=>{if(count===1){entered.resolve();await gate.promise;}}});
  const pending=vault.checkAccountKeys(request);await entered.promise;await assert.rejects(vault.checkAccountKeys(request),code('BUSY'));
  gate.resolve();assert.equal((await pending).matched,true);vault.lock();
});
test('worker context tampering and unexpected private fields are rejected',async()=>{
  for(const change of [{walletId:'00'.repeat(16)},{chainId:97},{account:'0x'+'ff'.repeat(20)},{epoch:3},{seed:'must-never-return'}]){
    const client=new Client(),original=client.request.bind(client);client.request=async(...args)=>({...await original(...args),...change});
    const {vault}=await setup({client});await assert.rejects(vault.checkAccountKeys(request),code('KEY_CONTEXT'));assert.equal(vault.accountCheck,null);vault.lock();
  }
});
test('changed authenticated vault data fails closed and locks the session',async()=>{
  const {vault,store}=await setup();store.record.cipher.data='00'+store.record.cipher.data.slice(2);
  await assert.rejects(vault.checkAccountKeys(request),code('AUTH_FAILED'));assert.equal(vault.unlocked,false);assert.equal(vault.accountCheck,null);
});
test('locked vault cannot perform root derivation',async()=>{
  const {vault,client}=await setup();vault.lock();await assert.rejects(vault.checkAccountKeys(request),code('LOCKED'));assert.deepEqual(client.calls,[]);
});
test('actual account-check worker builds a complete tree and rejects all signing requests',{timeout:90000},async()=>{
  const worker=new Worker(new URL('./fixtures/account-key-worker-node.mjs',import.meta.url));let id=0;const pending=new Map();
  worker.on('message',data=>{const row=pending.get(data.id);if(!row)return;
    if(data.progress!==undefined){row.progress?.(data.progress);return;}pending.delete(data.id);data.error?row.reject(new VaultError(data.error)):row.resolve(data.result);});
  worker.on('error',error=>{for(const row of pending.values())row.reject(error);pending.clear();});
  const ask=(type,payload,progress)=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject,progress});worker.postMessage({id:current,type,payload});});
  try{
    let progress=0;const result=await ask('check',{record:base.record,key:base.key,snapshot},value=>{assert.ok(value>=progress);progress=value;});
    assert.equal(progress,1);assert.deepEqual(Object.keys(result).sort(),['account','chainId','epoch','pubSeed','root','walletId']);
    assert.equal(result.account,account);assert.equal(result.pubSeed,snapshot.pubSeed);assert.match(result.root,/^0x[0-9a-f]{32}$/);
    await assert.rejects(ask('sign',{}),code('KEY_CONTEXT'));
  }finally{await worker.terminate();}
});
