import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
import {parentPort,workerData} from 'node:worker_threads';
import {accountRpc} from '../ui/account-state.js';
import {TestVault} from '../ui/vault-service.js';
import {decryptPayload,deriveVaultKey,hex} from '../ui/vault-crypto.js';
import {testIdentitySeeds,testActiveSeeds} from '../ui/test-wallet-core.js';
import {EvmTreeKey,word,addressWord,leftWord,concat,encodeExecute,encodeRekey,execHasher,rekeyHasher,chainSlot} from '../ui/lib/evmwots.js';
import {keccak256} from '../ui/lib/keccak.js';

const chain=31337;
const paySelector=keccak256(new TextEncoder().encode('pay(address,uint256)')).slice(0,4);

// Disposable stand-in for IndexedDB. Production vault mode and reservation checks run unchanged.
export function isolatedVault(){
  let record;
  const store={name:randomUUID(),read:async()=>structuredClone(record),
    async create(next){assert.equal(record,undefined);record=structuredClone(next);},
    async compareAndSwap(expected,next){assert.deepEqual(record,expected);record=structuredClone(next);}};
  const locks={request:(_key,_opts,run)=>run({})};
  return {vault:new TestVault(store,{locks,idleMs:10*60*1000}),store};
}

async function standbyAdmitted(device,tree,receiptHash){
  if(!/^0x[0-9a-f]{64}$/.test(receiptHash))return false;
  const url=new URL(device.endpoint);
  if(url.protocol!=='http:' || url.hostname!=='127.0.0.1')return false;
  const rpc=accountRpc(url.href);
  const encoded=bytes=>'0x'+hex(bytes);
  if(await rpc('eth_chainId')!=='0x7a69' || !/^anvil\b/i.test(await rpc('web3_clientVersion')))return false;
  const [receipt,head]=await Promise.all([rpc('eth_getTransactionReceipt',[receiptHash]),rpc('eth_getBlockByNumber',['finalized',false])]);
  if(receipt?.status!=='0x1' || receipt.to!==device.holder || receipt.transactionHash!==receiptHash ||
    !head || BigInt(receipt.blockNumber)>BigInt(head.number))return false;
  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  const event=encoded(keccak256(new TextEncoder().encode('Recovered(address,address)')));
  if(block?.hash!==receipt.blockHash || !block.transactions.includes(receiptHash) ||
    !receipt.logs.some(log=>log.address===device.holder && log.topics.length===3 && log.topics[0]===event &&
      log.topics[1]===encoded(addressWord(device.original)) && log.topics[2]===encoded(addressWord(device.account))))return false;
  const read=(to,method)=>rpc('eth_call',[{to,data:encoded(keccak256(new TextEncoder().encode(method)).slice(0,4))},head.number]);
  const values=await Promise.all([read(device.holder,'activeSigner()'),read(device.holder,'commitment()'),
    read(device.account,'pubSeed()'),read(device.account,'root()'),read(device.account,'epoch()'),read(device.account,'next()')]);
  const expected=[addressWord(device.account),word(0),leftWord(tree.pubSeed),leftWord(tree.root),word(1),word(0)].map(encoded);
  const [canonical,finalized]=await Promise.all([rpc('eth_getBlockByNumber',[head.number,false]),
    rpc('eth_getBlockByNumber',['finalized',false])]);
  return canonical?.hash===head.hash && finalized && BigInt(finalized.number)>=BigInt(head.number) &&
    (finalized.number!==head.number || finalized.hash===head.hash) && values.every((value,i)=>value===expected[i]);
}

async function runDevice(device){
  const {account,holder,recipient,role}=device;
  const {vault,store}=isolatedVault();
  const password=randomUUID(),{walletId}=await vault.create(password,chain);
  const record=await store.read(),key=await deriveVaultKey(password,record.kdf.salt);
  const master=Buffer.from((await decryptPayload(record,key)).seed,'hex');
  const build=({skSeed,pubSeed})=>EvmTreeKey.generate(skSeed,pubSeed);
  let identity,active;
  async function reserve(tree,epoch,leaf,digest){
    const entry={chainId:chain,account,epoch,leaf,root:hex(tree.root),pubSeed:hex(tree.pubSeed),digest:hex(digest)};
    await vault.reserveLeaf(entry);
    return entry;
  }
  try{
    identity=build(testIdentitySeeds(master,chain,Buffer.from(walletId,'hex')));
    active=build(testActiveSeeds(master,chain,account,1,randomBytes(16)));
    master.fill(0);
    const rnd=randomBytes(16),bootLeaf=chainSlot(chain);
    const digest=rekeyHasher(rnd,chain,account,0,bootLeaf,0,active.pubSeed,active.root)(0);
    await reserve(identity,0,bootLeaf,digest);
    const boot=encodeRekey(active.pubSeed,active.root,bootLeaf,0,0,rnd,identity.sign(bootLeaf,digest));
    identity.skSeed.fill(0);
    let waiting=once(parentPort,'message');
    parentPort.postMessage({seed:hex(identity.pubSeed),root:hex(identity.root),boot:'0x'+hex(boot),activeSeed:hex(active.pubSeed),activeRoot:hex(active.root),
      ...(role==='original'?{backup:await vault.exportBackup(),password}:{})});
    let [request]=await waiting;
    while(role==='standby' && !await standbyAdmitted(device,active,request.receiptHash).catch(()=>false)){
      waiting=once(parentPort,'message');
      parentPort.postMessage({refused:true,reservations:vault.details.reservations});
      [request]=await waiting;
    }
    const {deadline}=request;
    assert.ok(Number.isSafeInteger(deadline)&&deadline>0);
    const calls=[{to:holder,value:0n,data:concat(paySelector,addressWord(recipient),word(1))}];
    const paymentRnd=randomBytes(16),msg=execHasher(paymentRnd,chain,account,1,0,deadline,calls)(0);
    const entry=await reserve(active,1,0,msg);
    const data=encodeExecute(calls,0,deadline,0,paymentRnd,active.sign(0,msg));
    parentPort.postMessage({data:'0x'+hex(data),entry});
  }finally{
    master.fill(0);identity?.skSeed.fill(0);active?.skSeed.fill(0);vault.lock();
  }
}
if(parentPort)await runDevice(workerData);
