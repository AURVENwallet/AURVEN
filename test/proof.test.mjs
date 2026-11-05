import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEnvelope,decryptPayload,hex,VaultError} from '../ui/vault-crypto.js';
import {TestVault} from '../ui/vault-service.js';
import {ProofEngine} from '../ui/proof-engine.js';
import {LOCAL_PROOF_FORMAT,fromHex,verificationSeeds,proofDigest,verifyLocalProof,validateProofContext} from '../ui/local-proof.js';
import {testIdentitySeeds,testActiveSeeds} from '../ui/test-wallet-core.js';
import {EvmTreeKey,leafPk} from '../ui/lib/evmwots.js';

const password='Disposable local proof test input'; // Public fixture only.
const base=await createEnvelope(password,31337);
const code=expected=>error=>error.code===expected;
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
class Store {
  name='aurven-proof-fixture';record=structuredClone(base.record);
  async read(){if(this.beforeRead)await this.beforeRead();return structuredClone(this.record);}
  async compareAndSwap(expected,updated){
    if(this.beforeSave)await this.beforeSave();
    assert.deepEqual(this.record,expected);this.record=structuredClone(updated);
  }
}
class Locks {
  busy=false;
  async request(name,options,action){if(this.busy)return action(null);this.busy=true;try{return await action({name});}finally{this.busy=false;}}
}
// Two real leaves keep fault-injection tests fast; the separate worker test
// below generates all 1,024 leaves with the production browser worker module.
function partialTree(sk,pub,progress){
  const leaves=Array.from({length:1024},()=>new Uint8Array(16));
  leaves[0]=leafPk(sk,pub,0);leaves[1]=leafPk(sk,pub,1);progress?.(1);
  return new EvmTreeKey(sk,pub,leaves);
}
class EngineClient {
  engine=new ProofEngine(partialTree);calls=[];disposed=false;
  async request(type,payload,progress){
    this.calls.push(type);
    if(this.beforeRequest)await this.beforeRequest(type);
    if(this.disposed)throw new VaultError('CANCELED');
    return type==='build'?this.engine.build(payload.record,payload.key,progress):this.engine.sign(payload);
  }
  dispose(){this.disposed=true;this.engine.dispose();}
}
async function setup({store=new Store(),locks=new Locks(),client=new EngineClient()}={}){
  const vault=new TestVault(store,{locks,workerFactory:()=>client});await vault.unlock(password);
  return {vault,store,locks,client};
}
const context=tree=>({format:LOCAL_PROOF_FORMAT,purpose:'verification-only',...tree,leaf:0,message:'Public proof fixture',challenge:'12'.repeat(16)});

test('verification keys are separated from identity, transaction, network and wallet domains',async()=>{
  const master=fromHex((await decryptPayload(base.record,base.key)).seed),id=base.record.walletId;
  const a=verificationSeeds(master,31337,id);
  for(const other of [testIdentitySeeds(master,31337,fromHex(id)),testActiveSeeds(master,31337,'0x'+'11'.repeat(20),1,a.pubSeed),verificationSeeds(master,97,id),verificationSeeds(master,31337,'00'.repeat(16))])assert.notEqual(hex(a.skSeed),hex(other.skSeed));
  assert.throws(()=>verificationSeeds(master,56,id));master.fill(0);
});
test('proof schema rejects mainnet, raw digests, oversized messages and malformed fields',()=>{
  const fields={walletId:base.record.walletId,chainId:31337,pubSeed:'11'.repeat(16),root:'22'.repeat(16)};
  const good=context(fields);validateProofContext(good);
  for(const changed of [{...good,chainId:56},{...good,digest:'00'.repeat(16)},{...good,message:'x'.repeat(281)},{...good,message:' '},{...good,leaf:1024},{...good,challenge:'abc'},{...good,purpose:'transaction'}])assert.throws(()=>validateProofContext(changed));
});
test('engine binds every proof to its authenticated tree and rejects repeated leaves',async()=>{
  const engine=new ProofEngine(partialTree),tree=await engine.build(base.record,base.key);
  await assert.rejects(engine.build(base.record,base.key),code('BUSY'));
  for(const changed of [{walletId:'aa'.repeat(16)},{chainId:97},{pubSeed:'aa'.repeat(16)},{root:'aa'.repeat(16)}])assert.throws(()=>engine.sign({...context(tree),...changed}),code('PROOF_CONTEXT'));
  const result=engine.sign(context(tree));assert.equal(verifyLocalProof(result),true);
  for(const changed of [{message:'Modified'},{challenge:'ff'.repeat(16)},{leaf:1},{chainId:97},{walletId:'bb'.repeat(16)},{root:'cc'.repeat(16)},{proof:'00'.repeat(448)}])assert.equal(verifyLocalProof({...result,...changed}),false);
  assert.throws(()=>engine.sign({...context(tree),message:'Second digest'}),code('USED'));engine.dispose();
  assert.throws(()=>engine.sign(context(tree)),code('TREE_REQUIRED'));
});
test('vault saves before asking the worker to sign and independently verifies the result',async()=>{
  const {vault,store,client}=await setup();await vault.buildProofTree();
  const entered=deferred(),gate=deferred();store.beforeSave=()=>{entered.resolve();return gate.promise;};
  const pending=vault.signProofMessage('AURVEN local signature');await entered.promise;
  assert.deepEqual(client.calls,['build']);gate.resolve();const result=await pending;
  assert.equal(verifyLocalProof(result),true);assert.equal(result.leaf,0);
  const payload=await decryptPayload(store.record,base.key);assert.equal(payload.journal[0].digest,result.digest);
  assert.equal(vault.proofTree.nextLeaf,1);assert.equal(vault.details.reservations,1);vault.lock();
});
test('two sessions serialize signatures and derive the next leaf from the latest journal',async()=>{
  const a=await setup(),b=await setup({store:a.store,locks:a.locks});
  await a.vault.buildProofTree();await b.vault.buildProofTree();
  const entered=deferred(),gate=deferred();a.store.beforeSave=()=>{entered.resolve();return gate.promise;};
  const pending=a.vault.signProofMessage('First');await entered.promise;
  await assert.rejects(b.vault.signProofMessage('Competing'),code('BUSY'));gate.resolve();
  assert.equal((await pending).leaf,0);assert.equal((await b.vault.signProofMessage('Second')).leaf,1);
  a.vault.lock();b.vault.lock();
});
test('storage failure prevents the worker signature and terminates its key session',async()=>{
  const {vault,store,client}=await setup();await vault.buildProofTree();
  store.beforeSave=()=>{throw new VaultError('STORAGE');};
  await assert.rejects(vault.signProofMessage('Storage failure'),code('STORAGE'));
  assert.deepEqual(client.calls,['build']);assert.equal(client.disposed,true);assert.equal(vault.unlocked,false);
});
test('locking during a save consumes the committed leaf without exposing a proof',async()=>{
  const {vault,store,client}=await setup();await vault.buildProofTree();
  const entered=deferred(),gate=deferred();store.beforeSave=()=>{entered.resolve();return gate.promise;};
  const pending=vault.signProofMessage('Interrupted');await entered.promise;vault.lock();gate.resolve();
  await assert.rejects(pending,code('LOCKED'));assert.deepEqual(client.calls,['build']);
  const next=await setup({store});await next.vault.buildProofTree();
  assert.equal((await next.vault.signProofMessage('After unlock')).leaf,1);next.vault.lock();
});
test('canceling before an asynchronous read completes cannot start a late worker',async()=>{
  const {vault,store,client}=await setup(),gate=deferred(),entered=deferred();
  store.beforeRead=()=>{entered.resolve();return gate.promise;};
  const pending=vault.buildProofTree();await entered.promise;vault.cancelProof();gate.resolve();
  await assert.rejects(pending,code('CANCELED'));assert.deepEqual(client.calls,[]);assert.equal(vault.proofTree,null);vault.lock();
});
test('worker failure or a mismatched response burns the reservation and locks the vault',async()=>{
  for(const tamper of [false,true]){
    const {vault,store,client}=await setup();await vault.buildProofTree();
    const original=client.request.bind(client);
    client.request=async(type,payload)=>{
      if(!tamper)throw new VaultError('WORKER');
      return {...await original(type,payload),message:'Unexpected message'};
    };
    await assert.rejects(vault.signProofMessage('Expected message'),code(tamper?'PROOF_CONTEXT':'WORKER'));
    assert.equal((await decryptPayload(store.record,base.key)).journal.length,1);assert.equal(vault.unlocked,false);
  }
});
test('read-only imports cannot build a signing tree or sign messages',async()=>{
  const {encryptPayload}=await import('../ui/vault-crypto.js');
  const store=new Store();store.record=await encryptPayload(await decryptPayload(base.record,base.key),base.key,{...base.record,mode:'recovery-readonly'});
  const {vault,client}=await setup({store});await assert.rejects(vault.buildProofTree(),code('RECOVERY'));
  await assert.rejects(vault.signProofMessage('Rejected'),code('TREE_REQUIRED'));assert.deepEqual(client.calls,[]);vault.lock();
});
test('offline CLI accepts a valid exported proof and rejects tampering and oversized input',async()=>{
  const engine=new ProofEngine(partialTree),tree=await engine.build(base.record,base.key),proof=engine.sign(context(tree));
  const directory=mkdtempSync(join(tmpdir(),'aurven-proof-check-')),path=join(directory,'proof.json');
  const script=new URL('../scripts/verify-local-proof.mjs',import.meta.url);
  const check=()=>spawnSync(process.execPath,[fileURLToPath(script),path],{encoding:'utf8'});
  try{
    writeFileSync(path,JSON.stringify(proof));assert.equal(check().status,0);
    writeFileSync(path,JSON.stringify({...proof,message:'Modified'}));assert.equal(check().status,1);
    writeFileSync(path,' '.repeat(16385));assert.equal(check().status,1);
  }finally{engine.dispose();unlinkSync(path);rmdirSync(directory);}
});
test('actual worker generates all leaves, returns only public data and signs a verifiable proof',{timeout:90000},async()=>{
  const worker=new Worker(new URL('./fixtures/proof-worker-node.mjs',import.meta.url));
  let id=0;const pending=new Map();
  worker.on('message',data=>{
    const entry=pending.get(data.id);if(!entry)return;
    if(data.progress!==undefined){entry.progress?.(data.progress);return;}
    pending.delete(data.id);data.error?entry.reject(new VaultError(data.error)):entry.resolve(data.result);
  });
  worker.on('error',error=>{for(const entry of pending.values())entry.reject(error);pending.clear();});
  const request=(type,payload,progress)=>new Promise((resolve,reject)=>{const current=++id;pending.set(current,{resolve,reject,progress});worker.postMessage({id:current,type,payload});});
  try{
    let progress=0;const tree=await request('build',{record:base.record,key:base.key},value=>{assert.ok(value>=progress);progress=value;});
    assert.equal(progress,1);assert.deepEqual(Object.keys(tree).sort(),['chainId','pubSeed','root','walletId']);
    const result=await request('sign',context(tree));assert.equal(verifyLocalProof(result),true);
    assert.equal(result.digest,hex(proofDigest(context(tree))));
    await assert.rejects(request('sign',{...context(tree),message:'Reuse'}),code('USED'));
  }finally{await worker.terminate();}
});
