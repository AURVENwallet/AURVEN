import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {createEnvelope,decryptPayload,encryptPayload,hex,VaultError} from '../ui/vault-crypto.js';
import {deriveAccountRoot} from '../ui/account-key-engine.js';
import {validateKeySnapshot} from '../ui/account-key-check.js';
import {TestVault} from '../ui/vault-service.js';
import {accountCodeHash} from '../ui/contract-pin.js';
import {prepareTransfer} from '../ui/transfer.js';
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
async function setup({store=new Store(),client=new Client(),change=()=>{},locks={request:async(name,options,action)=>action({name})}}={}){
  const derived=await deriveAccountRoot({record:store.record,key:base.key,snapshot},null,partialTree);
  let reads=0;const reader=async args=>{
    assert.equal(args.chainId,31337);assert.equal(args.account,account);
    if (reads < 2) assert.ok(args.signal);
    const current={...snapshot,root:derived.root};reads++;await change(current,reads);return current;
  };
  const vault=new TestVault(store,{locks,accountReader:reader,bindingWorkerFactory:()=>client.disposed ? new Client() : client});
  await vault.unlock(password);return {vault,store,client,reads:()=>reads};
}
const request={account,endpoint:'https://example.test/disposable-provider-marker'};

async function reviewFixture(change = () => {}, overrides = {}, options = {}) {
  const instance = await setup({...options,change: async (state, n) => {
    state.balanceWei = '1000000000000000000';
    if (n > 2) await change(state);
  }});
  const binding = await instance.vault.checkAccountKeys(request);
  const transaction = prepareTransfer({account, chainId:31337, recipient:'0x'+'ab'.repeat(20),
    amount:'0.5',epoch:1,leaf:0,deadline:binding.snapshot.timestamp+600,randomizer:new Uint8Array(16),...overrides});
  return {...instance, binding, draft:{format:'bsc-key-lab-unsigned-transfer-v2',stateSource:'rpc-snapshot',
    snapshot:binding.snapshot,leafReserved:false,...transaction}};
}

test('review corroborates a generated draft with a new chain read and leaves the envelope byte-identical',async()=>{
  const {vault,draft,store,reads}=await reviewFixture();
  const original=structuredClone(store.record);
  const report=await vault.reviewTransferDraft(draft,request.endpoint);
  assert.equal(reads(),3);assert.deepEqual(report,{digest:draft.digest,leaf:0,blockHash:snapshot.blockHash,blockNumber:'0x1'});
  assert.deepEqual(store.record,original);vault.lock();
});
test('offline, tampered, additional-call and previously reserved drafts fail before querying the provider',async()=>{
  const {vault,draft,reads}=await reviewFixture();
  for(const [changes,reason] of [
    [{stateSource:'manual-offline'},'DRAFT_SOURCE'],[{valueWei:'1'},'DRAFT_DIGEST'],
    [{recipient:account},'DRAFT_DIGEST'],[{randomizer:'ff'.repeat(16)},'DRAFT_DIGEST'],
    [{calls:[]},'DRAFT_FORMAT'],[{leafReserved:true},'DRAFT_FORMAT'],[{snapshot:null},'DRAFT_FORMAT'],
    [{snapshot:{...draft.snapshot,account:5}},'DRAFT_FORMAT']
  ]) await assert.rejects(vault.reviewTransferDraft({...draft,...changes},request.endpoint),code(reason));
  vault.cancelAccountCheck();
  await assert.rejects(vault.reviewTransferDraft(draft,request.endpoint),code('DRAFT_KEYS'));
  assert.equal(reads(),2);vault.lock();
});
test('review catches a changed leaf, rotated root, insufficient balance, or regressed/replaced block',async()=>{
  for(const [changes,reason] of [
    [{next:1},'DRAFT_STALE'],[{root:snapshot.root},'DRAFT_KEYS'],[{balanceWei:'1'},'DRAFT_BALANCE'],
    [{blockNumber:'0x0'},'DRAFT_STALE'],[{blockHash:'0x'+'aa'.repeat(32)},'DRAFT_STALE']
  ]){
    const {vault,draft}=await reviewFixture(state=>Object.assign(state,changes));
    await assert.rejects(vault.reviewTransferDraft(draft,request.endpoint),code(reason));vault.lock();
  }
});
test('expiry uses a fresh block timestamp including the contract maximum horizon',async()=>{
  for(const offset of [-1,0,3601]){
    const {vault,draft}=await reviewFixture(undefined,{deadline:snapshot.timestamp+offset});
    await assert.rejects(vault.reviewTransferDraft(draft,request.endpoint),code('DRAFT_DEADLINE'));vault.lock();
  }
});
test('off-chain journal use blocks the draft even if the chain still shows the original counter',async()=>{
  const {vault,draft,store}=await reviewFixture();
  const payload=await decryptPayload(store.record,base.key);
  payload.journal.push({account,chainId:31337,epoch:1,leaf:7,pubSeed:draft.snapshot.pubSeed.slice(2),root:draft.snapshot.root.slice(2),digest:'aa'.repeat(16)});
  store.record=await encryptPayload(payload,base.key,{...store.record,revision:store.record.revision+1});
  const original=structuredClone(store.record);
  await assert.rejects(vault.reviewTransferDraft(draft,request.endpoint),code('DRAFT_LEAF'));
  assert.deepEqual(store.record,original);vault.lock();
});
test('canceling the review, clearing the key match or locking while the RPC is pending discards its response',async()=>{
  for (const action of ['abort','clear','lock']){
    const entered=deferred(),gate=deferred(),controller=new AbortController();
    const {vault,draft}=await reviewFixture(()=>{entered.resolve();return gate.promise;});
    const pending=vault.reviewTransferDraft(draft,request.endpoint,controller.signal);
    await entered.promise;
    if(action==='abort')controller.abort();
    if(action==='clear')vault.cancelAccountCheck();
    if(action==='lock')vault.lock();
    gate.resolve();await assert.rejects(pending,code(action==='lock'?'LOCKED':'CANCELED'));vault.lock();
  }
});
test('a restored backup cannot pass draft preflight even with a matching root',async()=>{
  const {vault,draft}=await reviewFixture();
  const oldReport=await vault.reviewTransferDraft(draft,request.endpoint);
  vault.lock();
  const store=new Store();
  store.record=await encryptPayload(await decryptPayload(store.record,base.key),base.key,{...store.record,mode:'recovery-readonly'});
  const recovery=await setup({store});
  assert.equal((await recovery.vault.checkAccountKeys(request)).matched,true);
  await assert.rejects(recovery.vault.reviewTransferDraft(draft,request.endpoint),code('RECOVERY'));
  await assert.rejects(recovery.vault.reserveTransferDraft(draft,request.endpoint,oldReport),code('DRAFT_REVIEW'));
  assert.equal(recovery.vault.details.reservations,0);recovery.vault.lock();
});

class WritableStore extends Store {
  writes = 0;
  async compareAndSwap(expected,updated) {
    if (this.beforeCommit) await this.beforeCommit();
    assert.deepEqual(this.record,expected);
    this.record = structuredClone(updated);
    this.writes++;
  }
}

test('a reservation binds the checked digest once and the next draft skips it after relocking',async()=>{
  const store = new WritableStore();
  const {vault,draft,reads} = await reviewFixture(undefined,{}, {store});
  const {endpoint} = request;
  await assert.rejects(vault.reserveTransferDraft(draft,endpoint),code('DRAFT_REVIEW'));
  const report = await vault.reviewTransferDraft(draft,endpoint);
  await assert.rejects(vault.reserveTransferDraft(draft,endpoint,{...report}),code('DRAFT_REVIEW'));
  const result = await vault.reserveTransferDraft(draft,endpoint,report);
  assert.equal(reads(),4);
  assert.equal(result.revision,1);
  assert.equal(vault.details.reservations,1);
  await assert.rejects(vault.reserveTransferDraft(draft,endpoint,report),code('DRAFT_REVIEW'));
  vault.lock();
  const next = await reviewFixture(undefined,{leaf:1},{store});
  assert.equal(await next.vault.suggestedTransferLeaf(next.draft.snapshot),1);
  await assert.rejects(next.vault.reviewTransferDraft(draft,endpoint),code('DRAFT_LEAF'));
  const nextReport = await next.vault.reviewTransferDraft(next.draft,endpoint);
  await next.vault.reserveTransferDraft(next.draft,endpoint,nextReport);
  const {journal} = await decryptPayload(store.record,base.key);
  assert.deepEqual(journal.map(row=>[row.leaf,row.digest]),[[0,draft.digest],[1,next.draft.digest]]);
  assert.deepEqual(journal[0],{chainId:draft.chainId,account,epoch:draft.epoch,root:draft.snapshot.root.slice(2),
    pubSeed:draft.snapshot.pubSeed.slice(2),leaf:0,digest:draft.digest});
  next.vault.lock();
});

test('reservation rechecks the observed balance, counter and review block before writing',async()=>{
  for (const [changes,reason] of [[{balanceWei:'0'},'DRAFT_BALANCE'],[{next:1},'DRAFT_STALE'],[{blockNumber:'0x1'},'DRAFT_STALE']]) {
    const store = new WritableStore();
    let reads = 0;
    const {vault,draft} = await reviewFixture(state=>{
      state.blockNumber = '0x2';
      if (++reads === 2) Object.assign(state,changes);
    },{}, {store});
    const report = await vault.reviewTransferDraft(draft,request.endpoint);
    await assert.rejects(vault.reserveTransferDraft(draft,request.endpoint,report),code(reason));
    assert.equal(store.writes,0);
    vault.lock();
  }
});

test('a second tab cannot reserve a competing digest during or after the first write',async()=>{
  const entered = deferred(), release = deferred(), store = new WritableStore();
  const locks = {held:false,async request(name,options,action) {
    if (this.held) return action(null);
    this.held = true;
    try {return await action({name});} finally {this.held = false;}
  }};
  const a = await reviewFixture(undefined,{}, {store,locks});
  const b = await reviewFixture(undefined,{amount:'0.1'}, {store,locks});
  const first = await a.vault.reviewTransferDraft(a.draft,request.endpoint);
  const second = await b.vault.reviewTransferDraft(b.draft,request.endpoint);
  store.beforeCommit = ()=>{entered.resolve();return release.promise;};
  const pending = a.vault.reserveTransferDraft(a.draft,request.endpoint,first);
  await entered.promise;
  await assert.rejects(b.vault.reserveTransferDraft(b.draft,request.endpoint,second),code('BUSY'));
  release.resolve(); await pending;
  await assert.rejects(b.vault.reviewTransferDraft(b.draft,request.endpoint),code('DRAFT_LEAF'));
  assert.equal(store.writes,1);a.vault.lock();b.vault.lock();
});

test('a lock during commit keeps the leaf consumed and a failed storage write cannot return success',async()=>{
  for (const mode of ['locked','failure']) {
    const store = new WritableStore();
    const {vault,draft} = await reviewFixture(undefined,{}, {store});
    const report = await vault.reviewTransferDraft(draft,request.endpoint);
    store.beforeCommit = ()=>{
      if (mode==='failure') throw new VaultError('STORAGE');
      vault.lock();
    };
    await assert.rejects(vault.reserveTransferDraft(draft,request.endpoint,report),code(mode==='failure'?'STORAGE':'LOCKED'));
    assert.equal(vault.unlocked,false);
    assert.equal(store.writes,mode==='failure'?0:1);
    const {journal} = await decryptPayload(store.record,base.key);
    assert.equal(journal.length,store.writes);
  }
});

test('reservations reject changed payloads, old sessions and the rotation-only leaf range',async()=>{
  const store = new WritableStore();
  const {vault,draft} = await reviewFixture(undefined,{}, {store});
  let report = await vault.reviewTransferDraft(draft,request.endpoint);
  await assert.rejects(vault.reserveTransferDraft({...draft,valueWei:'2'},request.endpoint,report),code('DRAFT_DIGEST'));
  report = await vault.reviewTransferDraft(draft,request.endpoint);
  vault.cancelAccountCheck();await vault.checkAccountKeys(request);
  await assert.rejects(vault.reserveTransferDraft(draft,request.endpoint,report),code('DRAFT_REVIEW'));
  await vault.reserveLeaf({chainId:31337,account,epoch:1,pubSeed:draft.snapshot.pubSeed.slice(2),root:draft.snapshot.root.slice(2),leaf:959,digest:'aa'.repeat(16)});
  await assert.rejects(vault.suggestedTransferLeaf(draft.snapshot),code('DRAFT_EXHAUSTED'));
  await assert.rejects(vault.reviewTransferDraft(draft,request.endpoint),code('DRAFT_EXHAUSTED'));
  assert.equal(store.writes,1);vault.lock();
});

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
  const {vault,store}=await setup();
  const cipher=store.record.cipher.data;
  store.record.cipher.data=(parseInt(cipher[0],16)^1).toString(16)+cipher.slice(1);
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
