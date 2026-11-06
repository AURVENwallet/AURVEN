import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {startLocalNode} from '../scripts/local-wallet-chain.mjs';
import {accountRpc,readAccount} from '../ui/account-state.js';
import {previewNetwork,submitNetwork,networkReceipt,checkOldApproval,retainNetworkHistory,reconcileNetwork} from '../ui/network-account.js';
import {networkHasher,spendingLeaf,validateIntent,encodeNetworkAction} from '../ui/vault-network-proof.js';
import {EvmTreeKey,grind} from '../ui/lib/evmwots.js';
import {hex} from '../ui/test-wallet-core.js';
import {TestVault} from '../ui/vault-service.js';
import {decryptPayload} from '../ui/vault-crypto.js';
import {createdAddress} from '../ui/browser-trial.js';

test('vault signs only after the encrypted leaf commit and refuses a restored copy',async t=>{
  let current,denyWrite=true,signed=0;
  const store={name:'network-order',read:async()=>current,create:async r=>{current=r;},
    compareAndSwap:async(old,next)=>{assert.equal(old,current);if(denyWrite)throw new Error('write refused');current=next;}};
  const locks={request:(_name,_opts,fn)=>fn({})};
  const password=randomBytes(20).toString('hex');
  const vault=new TestVault(store,{locks,networkWorkerFactory:()=>{
    let key,digest;
    return {dispose(){},async request(type,payload){
      if(type==='prepare'){
        key=payload.key;
        const info={leaf:8,seed:'11'.repeat(16),root:'22'.repeat(16),newSeed:'33'.repeat(16),newRoot:'44'.repeat(16),rnd:'55'.repeat(16),salt:0};
        digest=hex(networkHasher(payload.plan,info)(0));return {...info,digest};
      }
      assert.equal(type,'sign');const decoded=await decryptPayload(current,key);
      assert.equal(decoded.journal.length,1);assert.equal(decoded.journal[0].digest,digest);
      signed++;throw new Error('worker interrupted after commit');
    }};
  }});
  t.after(()=>vault.lock());
  const {walletId}=await vault.create(password,97);
  const payer='0x'+'12'.repeat(20),wrapper=createdAddress(payer,0),account=createdAddress(wrapper,1);
  const plan={kind:'create',value:'0x3',payer,recipient:payer,wrapper,nonce:'0x0',account,chainId:97,walletId,deadline:Math.floor(Date.now()/1000)+300};
  await assert.rejects(vault.authorizeNetworkAction(plan),/write refused/);assert.equal(signed,0);
  denyWrite=false;await assert.rejects(vault.authorizeNetworkAction(plan),/worker interrupted/);assert.equal(signed,1);
  await assert.rejects(vault.authorizeNetworkAction(plan),/USED/);assert.equal(signed,1);
  let restored;
  const copy=new TestVault({name:'restore',read:async()=>restored,create:async r=>{restored=r;}},{locks,networkWorkerFactory:()=>assert.fail('read-only signer')});
  t.after(()=>copy.lock());
  await copy.restoreBackup(await vault.exportBackup(),password);await copy.unlock(password);
  await assert.rejects(copy.authorizeNetworkAction(plan),/RECOVERY/);
});

test('receipt retention preserves account discovery and unresolved requests while freeing space for future transfers',()=>{
  const active={id:'active',kind:'create',status:'included'}, pending={id:'pending',kind:'send',status:'requested',deadline:0};
  const old={id:'old',kind:'send',status:'included'}, plan={kind:'send'};
  const full=[active,pending,old,...Array.from({length:29},(_,id)=>({...old,id}))];
  const keep=retainNetworkHistory(full,plan);
  assert.equal(keep.length,31);assert.ok(keep.includes(active)&&keep.includes(pending)&&!keep.includes(old));
  assert.equal(full.length,32);
  assert.throws(()=>retainNetworkHistory(Array(32).fill(pending),plan),/NET_HISTORY_FULL/);
  assert.throws(()=>retainNetworkHistory(Array(8).fill(active),{kind:'create'}),/NET_ACCOUNT_LIMIT/);
  assert.equal(retainNetworkHistory([...Array(7).fill(active),{kind:'create',status:'preparing',deadline:0}],{kind:'create'}).length,8);
});

test('reserved leaves advance independently of the confirmed counter and of the previous tree',()=>{
  const snapshot={next:0,pubSeed:'0x'+'11'.repeat(16),root:'0x'+'22'.repeat(16)};
  const spent={pubSeed:snapshot.pubSeed.slice(2),root:snapshot.root.slice(2),leaf:0};
  assert.equal(spendingLeaf({kind:'send',snapshot},[spent]),1);
  assert.equal(spendingLeaf({kind:'rotate',snapshot},[spent]),960);
  assert.equal(spendingLeaf({kind:'rotate',snapshot},[{...spent,leaf:960}]),961);
  assert.throws(()=>spendingLeaf({kind:'send',snapshot},[{...spent,leaf:960}]),/NET_EXHAUSTED/);
  assert.equal(spendingLeaf({kind:'send',snapshot:{...snapshot,root:'0x'+'33'.repeat(16)}},[spent]),0);
});

test('one chain-97 account executes separate transfers, rotates, rejects the previous authorization and spends with the new key',{timeout:240000},async t=>{
  const node=await startLocalNode(undefined,0,97);t.after(()=>node.close());
  const endpoint=node.endpoint,rpc=accountRpc(endpoint);
  const payer='0x'+randomBytes(20).toString('hex'),recipient='0x'+randomBytes(20).toString('hex'),walletId=hex(randomBytes(16));
  await rpc('anvil_setBalance',[payer,'0xde0b6b3a7640000']);await rpc('anvil_impersonateAccount',[payer]);
  const trees=Array.from({length:3},()=>EvmTreeKey.generate(randomBytes(32),randomBytes(16)));
  const init=JSON.parse(await readFile(new URL('../ui/assets/vault-setup-init.json',import.meta.url)));
  let saved=null,account,lastOld;
  const store={read:async()=>structuredClone(saved),create:async v=>{assert.equal(saved,null);saved=structuredClone(v);},
    compareAndSwap:async(before,after)=>{assert.deepEqual(saved,before);saved=structuredClone(after);}};
  const provider={request:({method,params})=>method==='eth_accounts'?[payer]:rpc(method,params)};
  const journal=[];
  const authorize=plan=>{
    const epoch=plan.snapshot?.epoch??0,tree=trees[epoch],leaf=spendingLeaf(plan,journal);
    const intent={leaf,seed:hex(tree.pubSeed),root:hex(tree.root),rnd:hex(randomBytes(16))};
    if (plan.kind!=='send') {intent.newSeed=hex(trees[epoch+1].pubSeed);intent.newRoot=hex(trees[epoch+1].root);}
    const best=grind(networkHasher(plan,intent),32);intent.salt=best.salt;intent.digest=hex(best.digest);
    validateIntent(plan,intent,leaf);journal.push({pubSeed:intent.seed,root:intent.root,leaf});
    return {intent,data:encodeNetworkAction(plan,intent,tree.sign(leaf,best.digest),init)};
  };
  for (const kind of ['create','send','send','rotate','send','fund']) {
    const plan=await previewNetwork(endpoint,{payer,recipient,kind,account,walletId});account=plan.account;
    const row=await submitNetwork({endpoint,store,provider,plan,authorize,walletId:()=>walletId});
    let result;
    for (let i=0;i<30;i++) {
      result=await networkReceipt(endpoint,row);
      if (result.status==='included') break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(result.status,'included');
    if (kind==='send' && plan.snapshot.epoch===1) lastOld={...row,...result};
    if (kind==='rotate'){
      assert.equal((await checkOldApproval(endpoint,lastOld)).reason,'BadSignature');
      assert.equal((await networkReceipt(endpoint,{...row,hash:undefined})).hash,row.hash);
    }
  }
  const current=await readAccount({endpoint,account,chainId:97});
  assert.deepEqual([current.epoch,current.next,current.balanceWei,current.root],[2,1,'3','0x'+hex(trees[2].root)]);
  assert.equal(await rpc('eth_getBalance',[recipient,'latest']),'0x3');
  assert.equal((await checkOldApproval(endpoint,lastOld)).reason,'BadSignature');

  // Fork the same signed transfer through the actual Anvil pool and alternative block histories.
  await rpc('evm_setAutomine',[false]);
  const checkpoint=await rpc('evm_snapshot');
  const nextPlan=await previewNetwork(endpoint,{payer,recipient,kind:'send',account,walletId});
  let originalTx;
  const capture={request:request=>{
    if (request.method==='eth_sendTransaction') originalTx=structuredClone(request.params[0]);
    return provider.request(request);
  }};
  const send=await submitNetwork({endpoint,store,provider:capture,plan:nextPlan,authorize,walletId:()=>walletId});
  const journalBefore=structuredClone(journal);
  const check=()=>reconcileNetwork(store,endpoint,send.id);
  assert.equal((await check()).status,'pending');
  await rpc('anvil_dropTransaction',[send.hash]);
  assert.equal((await check()).status,'unseen');
  assert.equal(await rpc('eth_sendTransaction',[originalTx]),send.hash);
  await rpc('evm_mine');
  const included=await check();
  assert.equal(included.status,'included');
  assert.equal(included.lastInclusion.hash,send.hash);

  assert.equal(await rpc('evm_revert',[checkpoint]),true);
  await rpc('evm_mine');
  const orphaned=await check();
  assert.equal(orphaned.status,'reorg');
  assert.deepEqual(orphaned.lastInclusion,included.lastInclusion);
  assert.equal(orphaned.feeWei,null);
  const branch=await rpc('evm_snapshot');
  assert.equal(await rpc('eth_sendTransaction',[originalTx]),send.hash);
  await rpc('evm_mine');
  const relocated=await check();
  assert.equal(relocated.status,'included');assert.ok(relocated.moved);
  assert.notEqual(relocated.lastInclusion.blockHash,included.lastInclusion.blockHash);
  assert.equal(await rpc('evm_revert',[branch]),true);
  const cancelBranch=await rpc('evm_snapshot');
  const different=await rpc('eth_sendTransaction',[{...originalTx,to:payer,value:'0x0',data:'0x'}]);
  await rpc('evm_mine');
  const replaced=await check();
  assert.equal(replaced.status,'replaced');assert.equal(replaced.replacementHash,different);
  assert.equal(replaced.hash,send.hash);
  assert.equal((await networkReceipt(endpoint,send,different)).status,'replaced');
  assert.equal(await rpc('eth_getBalance',[recipient,'latest']),'0x3');
  assert.equal(await rpc('evm_revert',[cancelBranch]),true);
  const faster=await rpc('eth_sendTransaction',[{...originalTx,gasPrice:'0x'+(2n*BigInt(originalTx.gasPrice)).toString(16)}]);
  await rpc('evm_mine');
  const equivalent=await check();
  assert.equal(equivalent.status,'included');assert.equal(equivalent.hash,faster);
  assert.equal(equivalent.submittedHash,send.hash);assert.ok(equivalent.equivalent);
  assert.equal(equivalent.replacementHash,null);
  assert.deepEqual(journal,journalBefore);
  assert.equal(spendingLeaf(nextPlan,journal),send.intent.leaf+1);

  // The same proof cannot execute twice. The outer payment still has a mined receipt and fee.
  const nonce=await rpc('eth_getTransactionCount',[payer,'latest']);
  const replay=await rpc('eth_sendTransaction',[{...originalTx,nonce}]);
  await rpc('evm_mine');
  const failed=await networkReceipt(endpoint,{...send,nonce,hash:replay,submittedHash:replay});
  assert.equal(failed.status,'reverted');assert.ok(BigInt(failed.feeWei)>0n);
  assert.equal(await rpc('eth_getBalance',[recipient,'latest']),'0x4');
});
