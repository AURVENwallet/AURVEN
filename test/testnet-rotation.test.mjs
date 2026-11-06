import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {startLocalNode,pinnedRuntime} from '../scripts/local-wallet-chain.mjs';
import {accountRpc} from '../ui/account-state.js';
import {EXEC_LIMIT,PROOF_LEN,encodeRekey,rekeyHasher,rootFromProof,word} from '../ui/lib/evmwots.js';
import {digestData} from '../ui/network-receipt.js';
import {exportRotationRecord,recoverTestnetRotation,validateRotationRecord} from '../ui/testnet-rotation.js';

const asHex=value=>'0x'+Buffer.from(value).toString('hex');
const account='0x'+'14'.repeat(20),payer='0x'+'24'.repeat(20);
function fixture(){
  const epoch=1,leaf=EXEC_LIMIT+1,deadline=Math.floor(Date.now()/1000)+600;
  const seed=randomBytes(16),newSeed=randomBytes(16),newRoot=randomBytes(16),rnd=randomBytes(16),proof=randomBytes(PROOF_LEN);
  const digest=rekeyHasher(rnd,97,account,epoch,leaf,deadline,newSeed,newRoot)(1);
  const root=rootFromProof(seed,leaf,digest,proof);
  const data=asHex(encodeRekey(newSeed,newRoot,leaf,deadline,1,rnd,proof));
  const row={kind:'rotate',chainId:97,account,payer,nonce:'0x0',startBlock:'0x0',deadline,dataHash:digestData(data),
    snapshot:{epoch,root:asHex(root),pubSeed:asHex(seed)},intent:{leaf,newSeed:newSeed.toString('hex'),newRoot:newRoot.toString('hex')}};
  return {row,data,record:exportRotationRecord(row)};
}
test('only public rotation fields can cross profiles and malformed input is rejected before contacting nodes',async t=>{
  const {row,record}=fixture();
  assert.deepEqual(exportRotationRecord({...row,walletId:'private marker',hash:'ignored',signedData:'unused'}),record);
  for(const other of [{kind:'send'},{intent:null},{snapshot:null},{chainId:56}])
    assert.throws(()=>exportRotationRecord({...row,...other}),/ROTATION_FILE/);
  t.mock.method(globalThis,'fetch',()=>assert.fail('Unexpected network access'));
  for(const changes of [{nonce:'1'},{startBlock:'0x01'},{epoch:0},{leaf:959},{leaf:1024},{chainId:56},{extra:1},{newRoot:record.oldRoot}]){
    await assert.rejects(recoverTestnetRotation({...record,...changes}),/ROTATION_FILE/);
  }
  assert.equal(validateRotationRecord(record),record);
  await assert.rejects(recoverTestnetRotation(record,{txHash:'bad'}),/ROTATION_TX/);
});

test('two routes recover a mined rotation by nonce or paged blocks, and withhold confirmation on disputes and reorgs',async t=>{
  const node=await startLocalNode(undefined,0,97);t.after(()=>node.close());
  const rpc=accountRpc(node.endpoint),{record:r,data}=fixture(),slots=n=>asHex(word(n));
  await rpc('anvil_setCode',[account,await pinnedRuntime()]);
  await rpc('anvil_setStorageAt',[account,slots(0),r.oldRoot+r.oldSeed.slice(2)]);
  await rpc('anvil_setStorageAt',[account,slots(1),slots(1n<<32n)]);
  await rpc('anvil_setBalance',[payer,'0xde0b6b3a7640000']);await rpc('anvil_impersonateAccount',[payer]);
  await rpc('anvil_mine',['0x16']);
  const tx=await rpc('eth_sendTransaction',[{from:payer,to:account,data,gas:'0xaae60'}]);
  await rpc('evm_mine');
  assert.equal((await rpc('eth_getTransactionReceipt',[tx])).status,'0x1');
  const head=await rpc('eth_blockNumber'),originalFetch=globalThis.fetch;
  let mode='normal',pruned=false;
  const methods=new Set();
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const secondary=String(url).includes('dataseed'),request=JSON.parse(options.body),{method,params}=request;
    methods.add(method);
    if(method==='eth_getBlockByNumber' && params[0]==='finalized')params[0]='latest';
    if(pruned && method==='eth_getTransactionCount' && params[1]!==head)throw new Error('Pruned');
    if(secondary && mode==='outage')throw new Error('Offline');
    const response=await originalFetch(node.endpoint,{...options,body:JSON.stringify(request)});
    const reply=await response.json();
    if(secondary && mode==='fork' && method==='eth_getBlockByNumber' && params[0]==='latest')reply.result.hash=asHex(word(999));
    if(secondary && mode==='missing' && method==='eth_getTransactionReceipt')reply.result=null;
    if(secondary && mode==='revert' && method==='eth_getTransactionReceipt')reply.result.status='0x0';
    if(secondary && mode==='orphan' && method==='eth_getBlockByNumber' && params[0]==='0xf')reply.result.hash=asHex(word(333));
    return Response.json(reply);
  });
  const read=(record=r,options={})=>recoverTestnetRotation(record,options);
  assert.equal((await read()).hash,tx);
  pruned=true;
  const first=await read();assert.equal(first.status,'continue');assert.equal(first.cursor.number,'0xf');
  let result=await read(r,{cursor:first.cursor});assert.equal(result.status,'current');assert.equal(result.hash,tx);
  assert.equal(result.root,r.newRoot);assert.equal(result.epoch,2);
  mode='orphan';await assert.rejects(read(r,{cursor:first.cursor}),/ROTATION_CURSOR/);
  mode='outage';await assert.rejects(read(r,{txHash:tx}),/ROTATION_NODES/);
  mode='fork';await assert.rejects(read(r,{txHash:tx}),/ROTATION_CONFLICT/);
  mode='missing';await assert.rejects(read(r,{txHash:tx}),/ROTATION_HISTORY/);
  mode='revert';await assert.rejects(read(r,{txHash:tx}),/ROTATION_CONFLICT|ROTATION_HISTORY/);
  mode='normal';
  for(const change of [{deadline:r.deadline-1},{oldRoot:r.newSeed},{leaf:r.leaf+1},{oldSeed:r.newRoot}]){
    await assert.rejects(read({...r,...change},{txHash:tx}),/HANDOVER_PROOF/);
  }
  assert.equal((await read({...r,dataHash:asHex(word(19))},{txHash:tx})).status,'replaced');
  assert.equal((await read({...r,nonce:'0x1'})).status,'waiting');
  assert.equal((await read({...r,nonce:'0x1',deadline:1})).status,'expired');
  assert.deepEqual([...methods].sort(),['eth_call','eth_chainId','eth_getBalance','eth_getBlockByNumber','eth_getCode',
    'eth_getTransactionByHash','eth_getTransactionCount','eth_getTransactionReceipt'].sort());
  t.mock.restoreAll();
  await rpc('anvil_setStorageAt',[account,slots(0),r.oldRoot+r.oldSeed.slice(2)]);
  await rpc('anvil_setStorageAt',[account,slots(1),slots(3n<<32n)]);await rpc('evm_mine');
  t.mock.method(globalThis,'fetch',(_url,options)=>{
    const request=JSON.parse(options.body);
    if(request.method==='eth_getBlockByNumber'&&request.params[0]==='finalized')request.params[0]='latest';
    return originalFetch(node.endpoint,{...options,body:JSON.stringify(request)});
  });
  result=await read(r,{txHash:tx});assert.equal(result.status,'superseded');assert.equal(result.epoch,3);
});
