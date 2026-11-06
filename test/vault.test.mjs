import test from 'node:test';
import assert from 'node:assert/strict';
import {createEnvelope,decryptPayload,deriveVaultKey,encryptPayload,parseBackup,validateEnvelope,VaultError,MAX_BACKUP_BYTES} from '../ui/vault-crypto.js';
import {TestVault} from '../ui/vault-service.js';
import {compareBackupJournal} from '../ui/backup-recovery.js';
import {accountCodeHash} from '../ui/contract-pin.js';
import {TestSigningSession,hex} from '../ui/test-wallet-core.js';
import {EvmTreeKey,leafPk,rootFromProof} from '../ui/lib/evmwots.js';

// Public, disposable test input; never use this password for a real vault.
const passphrase='AURVEN disposable test input';
const base=await createEnvelope(passphrase,31337);
const copy=value=>structuredClone(value);
const code=expected=>error=>error instanceof VaultError&&error.code===expected;
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
class MemoryStore {
  name='aurven-test-memory';
  constructor(record=base.record){this.record=copy(record);}
  async read(){return copy(this.record);}
  async create(record){if(this.record)throw new VaultError('EXISTS');this.record=copy(record);}
  async compareAndSwap(expected,updated){
    if(this.beforeWrite)await this.beforeWrite();
    if(JSON.stringify(this.record)!==JSON.stringify(expected))throw new VaultError('CONFLICT');
    this.record=copy(updated);
  }
}
class Locks {
  active=new Set();
  async request(name,options,action){
    assert.equal(options.mode,'exclusive');assert.equal(options.ifAvailable,true);
    if(this.active.has(name))return action(null);
    this.active.add(name);try{return await action({name});}finally{this.active.delete(name);}
  }
}
const row={chainId:31337,account:'0x'+'11'.repeat(20),epoch:1,pubSeed:'22'.repeat(16),root:'33'.repeat(16),leaf:0,digest:'44'.repeat(16)};
async function session(store=new MemoryStore(),locks=new Locks(),options={}){
  const vault=new TestVault(store,{locks,...options});await vault.unlock(passphrase);return {vault,store,locks};
}

test('a saved backup is authenticated and compared without updating or replacing the active vault',async()=>{
  const {vault,store}=await session();
  const early=await vault.exportBackup();
  await vault.reserveLeaf(row);
  const current=await vault.exportBackup(),original=copy(store.record);
  assert.deepEqual(await vault.checkBackupFile(early),{status:'older',savedCount:0,currentCount:1,checkedRevision:original.revision});
  assert.equal((await vault.checkBackupFile(current)).status,'matches');
  const damaged=JSON.parse(current);damaged.revision++;
  await assert.rejects(vault.checkBackupFile(JSON.stringify(damaged)),code('BACKUP_INVALID'));
  damaged.walletId='77'.repeat(16);
  await assert.rejects(vault.checkBackupFile(JSON.stringify(damaged)),code('BACKUP_SOURCE'));
  const plain=await decryptPayload(original,base.key);
  plain.journal[0].digest='12'.repeat(16);
  const branch=await encryptPayload(plain,base.key,original);
  assert.equal((await vault.checkBackupFile(JSON.stringify(branch))).status,'different');
  plain.seed='aa'.repeat(32);
  const foreignSeed=await encryptPayload(plain,base.key,original);
  await assert.rejects(vault.checkBackupFile(JSON.stringify(foreignSeed)),code('BACKUP_SOURCE'));
  assert.equal(vault.unlocked,true);assert.deepEqual(store.record,original);
  vault.lock();await assert.rejects(vault.checkBackupFile(current),code('LOCKED'));
});

test('backup comparison checks entry order, context, digest and single-use simulation attempts',()=>{
  const used={...row,simulationAttempt:true},next={...row,leaf:1};
  assert.equal(compareBackupJournal([row],[used]),'older');
  assert.equal(compareBackupJournal([used],[row]),'different');
  assert.equal(compareBackupJournal([row,next],[next,row]),'different');
  assert.equal(compareBackupJournal([row,next],[row]),'different');
  for(const field of ['account','epoch','chainId','pubSeed','root','leaf','digest'])
    assert.equal(compareBackupJournal([row],[{...row,[field]:null}]),'different');
  assert.equal(compareBackupJournal([used,next],[used,next]),'matches');
});

test('restored testnet profiles list only journal candidates and can check the last consumed leaf without writing',async()=>{
  const fixture=await createEnvelope(passphrase,97);
  const entry={...row,chainId:97},other='0x'+'66'.repeat(20);
  const plain=await decryptPayload(fixture.record,fixture.key);
  plain.journal=[entry,{...entry,leaf:1},{...entry,account:other,leaf:2},
    {...entry,account:'0x'+'00'.repeat(20),leaf:3}];
  const saved=await encryptPayload(plain,fixture.key,fixture.record);
  const state={account:entry.account,chainId:97,epoch:1,next:2,pubSeed:'0x'+entry.pubSeed,root:'0x'+entry.root,
    balanceWei:'123',timestamp:Math.floor(Date.now()/1000),blockNumber:'0xf',blockHash:'0x'+'ac'.repeat(32),codeHash:accountCodeHash};
  let reads=0,change={},mismatch=false;
  const options={locks:new Locks(),accountReader:()=>assert.fail('unexpected single-node query'),
    recoveryReader:async()=>++reads%2?{...state}:{...state,...change},bindingWorkerFactory:()=>({
      dispose(){},async request(type,{record,snapshot}){
        assert.equal(type,'check');assert.equal(record.mode,'recovery-readonly');
        return {walletId:record.walletId,chainId:97,account:entry.account,epoch:snapshot.epoch,
          pubSeed:snapshot.pubSeed,root:mismatch?'0x'+'ef'.repeat(16):snapshot.root};
      }
    })};
  const store=new MemoryStore(null),vault=new TestVault(store,options);
  const request={account:entry.account,fromBackup:true};
  await vault.restoreBackup(JSON.stringify(saved),passphrase);
  assert.deepEqual(vault.recoveredAccounts,[entry.account,other]);assert.equal(reads,0);
  vault.recoveredAccounts.pop();assert.equal(vault.recoveredAccounts.length,2);
  const original=copy(store.record);
  const report=await vault.checkAccountKeys(request);
  assert.equal(report.matched,true);assert.equal(report.snapshot.balanceWei,'123');
  assert.deepEqual(report.backupReview,{currentTreeReservations:2,lastChainLeafRecorded:true});
  state.next=3;assert.equal((await vault.checkAccountKeys(request)).backupReview.lastChainLeafRecorded,false);
  state.next=0;assert.equal((await vault.checkAccountKeys(request)).backupReview.lastChainLeafRecorded,null);
  mismatch=true;assert.equal((await vault.checkAccountKeys(request)).matched,false);
  for(change of [{next:7},{blockNumber:'0x1'},{blockHash:'0x'+'ab'.repeat(32)},{balanceWei:'0'}]){
    await assert.rejects(vault.checkAccountKeys(request),code('ACCOUNT_CHANGED'));
    assert.equal(vault.accountCheck,null);
  }
  await assert.rejects(vault.reserveLeaf(entry),code('RECOVERY'));
  await assert.rejects(vault.checkBackupFile(JSON.stringify(saved)),code('RECOVERY'));
  assert.deepEqual(store.record,original);vault.lock();assert.deepEqual(vault.recoveredAccounts,[]);
  const active=await session(new MemoryStore(saved),options.locks,options);
  await assert.rejects(active.vault.checkAccountKeys(request),code('KEY_CONTEXT'));active.vault.lock();
});

test('vault encryption round-trips without storing plaintext and uses non-extractable keys',async()=>{
  const plain=await decryptPayload(base.record,base.key);
  assert.equal(plain.seed.length,64);assert.deepEqual(plain.journal,[]);
  assert.equal(base.key.extractable,false);
  assert.ok(!JSON.stringify(base.record).includes(plain.seed));
  assert.ok(!JSON.stringify(base.record).includes(passphrase));
  const again=await encryptPayload(plain,base.key,base.record);
  assert.notEqual(again.cipher.iv,base.record.cipher.iv);
  assert.notEqual(again.cipher.data,base.record.cipher.data);
  const fresh=await createEnvelope(passphrase,31337);
  assert.notEqual(fresh.record.walletId,base.record.walletId);assert.notEqual(fresh.record.kdf.salt,base.record.kdf.salt);
  assert.notEqual((await decryptPayload(fresh.record,fresh.key)).seed,plain.seed);
});
test('wrong passwords and tampering with ciphertext or authenticated metadata are rejected',async()=>{
  const wrong=await deriveVaultKey('Another disposable password',base.record.kdf.salt);
  await assert.rejects(decryptPayload(base.record,wrong),code('AUTH_FAILED'));
  for(const change of [r=>r.chainId=97,r=>r.revision++,r=>r.mode='recovery-readonly',r=>r.walletId='55'.repeat(16),r=>r.createdAt++,r=>r.kdf.salt='66'.repeat(16),r=>r.cipher.iv='77'.repeat(12),r=>r.cipher.data=(r.cipher.data[0]==='0'?'1':'0')+r.cipher.data.slice(1)]){
    const record=copy(base.record);change(record);
    await assert.rejects(decryptPayload(record,base.key),code('AUTH_FAILED'));
  }
});
test('untrusted backups reject unsupported networks, KDF costs, oversized input and unexpected fields',async()=>{
  for(const change of [r=>r.chainId=56,r=>r.testOnly=false,r=>r.kdf.iterations=1,r=>r.kdf.iterations=1e12,r=>r.revision=-1,r=>r.extra=true,r=>r.cipher.iv='ab']){
    const record=copy(base.record);change(record);assert.throws(()=>parseBackup(JSON.stringify(record)),code('FORMAT'));
  }
  assert.throws(()=>parseBackup(' '.repeat(MAX_BACKUP_BYTES+1)),code('FORMAT'));
  await assert.rejects(createEnvelope(passphrase,56),code('NETWORK'));
  await assert.rejects(createEnvelope('short',97),code('PASSWORD'));
  await assert.rejects(createEnvelope(' '.repeat(12),97),code('PASSWORD'));
});
test('creating a vault cannot overwrite stored keys, including concurrent creation',async()=>{
  const store=new MemoryStore(null),locks=new Locks();
  const a=new TestVault(store,{locks}),b=new TestVault(store,{locks});
  const attempts=await Promise.allSettled([a.create(passphrase,97),b.create(passphrase,97)]);
  assert.equal(attempts.filter(v=>v.status==='fulfilled').length,1);
  const original=copy(store.record);
  await assert.rejects(b.create(passphrase,97),code('EXISTS'));assert.deepEqual(store.record,original);a.lock();b.lock();
});
test('manual locking and idle deadlines deny export and reservation; late unlock cannot reopen',async()=>{
  let clock=0;const {vault,store}=await session(undefined,undefined,{now:()=>clock,idleMs:1000});
  clock=1001;
  await assert.rejects(vault.exportBackup(),code('LOCKED'));
  await assert.rejects(vault.reserveLeaf(row),code('LOCKED'));
  const gate=deferred(),read=store.read.bind(store);store.read=async()=>{await gate.promise;return read();};
  const pending=vault.unlock(passphrase);vault.lock('hidden');gate.resolve();
  await assert.rejects(pending,code('LOCKED'));assert.equal(vault.unlocked,false);
});
test('failed authentication leaves no unlocked session',async()=>{
  const {vault}=await session();
  await assert.rejects(vault.unlock('Wrong test input'),code('AUTH_FAILED'));
  assert.equal(vault.unlocked,false);await assert.rejects(vault.exportBackup(),code('LOCKED'));
});
test('reservations survive a new session and cannot be bypassed with a new account, epoch or digest',async()=>{
  const {vault,store,locks}=await session();await vault.reserveLeaf(row);vault.lock();
  const reopened=(await session(store,locks)).vault;
  for(const changed of [row,{...row,digest:'99'.repeat(16)},{...row,epoch:2},{...row,account:'0x'+'aa'.repeat(20)}]){
    await assert.rejects(reopened.reserveLeaf(changed),code('USED'));
  }
  await assert.rejects(reopened.reserveLeaf({...row,chainId:97,leaf:1}),code('NETWORK'));
  assert.equal(reopened.details.reservations,1);reopened.lock();
});
test('cross-tab exclusive writes reject competing reservations before either can reuse a key',async()=>{
  const {vault:a,store,locks}=await session(),b=(await session(store,locks)).vault;
  const entered=deferred(),gate=deferred();store.beforeWrite=()=>{entered.resolve();return gate.promise;};
  const pending=a.reserveLeaf(row);await entered.promise;
  await assert.rejects(b.reserveLeaf({...row,digest:'aa'.repeat(16)}),code('BUSY'));
  gate.resolve();await pending;
  await assert.rejects(b.reserveLeaf(row),code('USED'));a.lock();b.lock();
});
test('compare-and-swap detects changes made outside the cooperative lock',async()=>{
  const {vault,store}=await session();
  store.beforeWrite=()=>{store.record.revision++;};
  await assert.rejects(vault.reserveLeaf(row),code('CONFLICT'));assert.equal(vault.unlocked,false);
});
test('older records are rejected in the live process, including after locking and unlocking',async()=>{
  const {vault,store}=await session(),old=copy(store.record);
  await vault.reserveLeaf(row);vault.lock();store.record=old;
  await assert.rejects(vault.unlock(passphrase),code('ROLLBACK'));assert.equal(vault.unlocked,false);
});
test('backup restoration is always read-only and cannot overwrite an existing vault',async()=>{
  const {vault:source}=await session();await source.reserveLeaf(row);
  const backup=await source.exportBackup(),store=new MemoryStore(null),restored=new TestVault(store,{locks:new Locks()});
  await restored.restoreBackup(backup,passphrase);
  assert.equal(restored.details.mode,'recovery-readonly');assert.equal(restored.details.reservations,1);
  await assert.rejects(restored.reserveLeaf({...row,leaf:1}),code('RECOVERY'));
  const exported=parseBackup(await restored.exportBackup());assert.equal(exported.mode,'recovery-readonly');
  exported.mode='active';
  await assert.rejects(decryptPayload(exported,await deriveVaultKey(passphrase,exported.kdf.salt)),code('AUTH_FAILED'));
  const original=copy(store.record);
  await assert.rejects(restored.restoreBackup(backup,passphrase),code('EXISTS'));assert.deepEqual(store.record,original);source.lock();restored.lock();
});

// A public one-leaf fixture tests the actual WOTS signer; other siblings are
// opaque test data. No real wallet material is used or saved.
const sk=new Uint8Array(32).fill(7),pub=new Uint8Array(16).fill(3),digest=new Uint8Array(16).fill(4);
const leaves=Array.from({length:1024},()=>new Uint8Array(16));leaves[0]=leafPk(sk,pub,0);
const tree=new EvmTreeKey(sk,pub,leaves);
const bind=(vault,record)=>vault.reserveLeaf({chainId:31337,account:row.account,epoch:1,...record});
test('actual signatures are withheld until durable reservation completes',async()=>{
  const {vault,store}=await session(),entered=deferred(),gate=deferred();
  store.beforeWrite=()=>{entered.resolve();return gate.promise;};
  const signer=new TestSigningSession(record=>bind(vault,record));let released=false;
  const pending=signer.sign(tree,0,digest).then(proof=>{released=true;return proof;});
  await entered.promise;assert.equal(released,false);
  gate.resolve();const proof=await pending;
  assert.equal(hex(rootFromProof(pub,0,digest,proof)),hex(tree.root));
  assert.equal((await decryptPayload(store.record,base.key)).journal.length,1);vault.lock();
});
test('storage failure never releases a signature and locks the session',async()=>{
  const {vault,store}=await session();store.beforeWrite=()=>{throw new VaultError('STORAGE');};
  let calls=0;const guarded={pubSeed:tree.pubSeed,root:tree.root,sign(){calls++;return tree.sign(0,digest);}};
  const signer=new TestSigningSession(record=>bind(vault,record));
  await assert.rejects(signer.sign(guarded,0,digest),code('STORAGE'));
  assert.equal(calls,0);assert.equal(vault.unlocked,false);
});
test('locking during an in-flight save burns the committed leaf without releasing a signature',async()=>{
  const {vault,store}=await session(),entered=deferred(),gate=deferred();
  store.beforeWrite=()=>{entered.resolve();return gate.promise;};
  const signer=new TestSigningSession(record=>bind(vault,record));
  const pending=signer.sign(tree,0,digest);await entered.promise;vault.lock('hidden');gate.resolve();
  await assert.rejects(pending,code('LOCKED'));
  await vault.unlock(passphrase);
  await assert.rejects(new TestSigningSession(record=>bind(vault,record)).sign(tree,0,digest),code('USED'));vault.lock();
});
test('authenticated payload validation rejects duplicate or cross-network journal entries',async()=>{
  const payload=await decryptPayload(base.record,base.key);
  await assert.rejects(encryptPayload({...payload,journal:[row,row]},base.key,base.record),code('FORMAT'));
  await assert.rejects(encryptPayload({...payload,journal:[{...row,chainId:97}]},base.key,base.record),code('FORMAT'));
});
test('unsupported lock managers fail closed',()=>{
  assert.throws(()=>new TestVault(new MemoryStore(),{locks:null}),code('UNSUPPORTED'));
  assert.equal(validateEnvelope(base.record),base.record);
});
