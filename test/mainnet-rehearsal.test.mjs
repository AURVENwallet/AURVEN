import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocalNode} from '../scripts/local-wallet-chain.mjs';
import {rehearseMainnet} from '../scripts/mainnet-rehearsal.mjs';
import {mainnetIdentitySeeds,mainnetActiveSeeds} from '../scripts/mainnet-setup.mjs';
import {testIdentitySeeds,testActiveSeeds} from '../ui/test-wallet-core.js';
import {accountRpc} from '../ui/account-state.js';

test('chain-56 rehearsal verifies simulated state without persisting a transaction',async t=>{
  const node=await startLocalNode();
  t.after(()=>node.close());
  const local=accountRpc(node.endpoint);
  await local('anvil_setChainId',[56]);
  await local('evm_mine');
  const head=await local('eth_blockNumber');
  const reads=new Set(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getTransactionCount','eth_getBalance',
    'eth_call','eth_estimateGas','eth_gasPrice']);
  const seen=[];
  const observer=(method,params)=>{
    assert.ok(reads.has(method),method);
    seen.push(method);
    return local(method,params);
  };
  const report=await rehearseMainnet([observer,observer]);
  assert.equal(report.chainId,56);
  assert.equal(report.simulationOnly,true);
  assert.deepEqual([report.finalEpoch,report.nextLeaf,report.fixtureBalanceWei,report.realFeeWei],[2,1,'1','0']);
  assert.ok(BigInt(report.factoryGas)>1000000n);
  assert.ok(BigInt(report.atomicSetup.factoryGas)>1000000n);
  assert.ok(BigInt(report.atomicSetup.createAndActivateGas)>1000000n);
  assert.deepEqual([report.atomicSetup.bootstrapLeaf,report.atomicSetup.treeLeaves,report.atomicSetup.nextLeaf],[9,1024,1]);
  assert.equal(seen.filter(m=>m==='eth_call').length,10);
  assert.equal(await local('eth_blockNumber'),head);
});

test('wrong chain or inconsistent finalized hashes abort before simulation',async()=>{
  const header={number:'0x20',timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),hash:'0x'+'12'.repeat(32)};
  const peer=(chain,hash)=>async method=>{
    if(method==='eth_chainId')return chain;
    assert.equal(method,'eth_getBlockByNumber');
    return {...header,hash};
  };
  const valid=peer('0x38',header.hash);
  await assert.rejects(rehearseMainnet([peer('0x61',header.hash),valid]),/chain 56 required/);
  await assert.rejects(rehearseMainnet([valid,peer('0x38','0x'+'34'.repeat(32))]),/heads disagree/);
});

test('BSC mainnet key domains match fixed vectors and isolate test vaults and factory instances',()=>{
  const master=new Uint8Array(32).fill(7),walletId=new Uint8Array(16).fill(9),pubSeed=new Uint8Array(16).fill(3);
  const account='0x'+'11'.repeat(20),factory='0x'+'22'.repeat(20);
  const identity=mainnetIdentitySeeds(master,factory,walletId);
  const active=mainnetActiveSeeds(master,factory,walletId,account,1,pubSeed);
  const hex=b=>Buffer.from(b).toString('hex');
  assert.equal(hex(identity.skSeed),'ee0a09e4db9ec2f8ba82152f45bfd60aaf0c00745cd061eb8247011e1aac71bf');
  assert.equal(hex(identity.pubSeed),'0d68a9cd918332286181336be273b20e');
  assert.equal(hex(active.skSeed),'db896b1a2c1be3c851c4ff5e0295c78078a7a4b2385db613f0fe343561f688ca');
  const otherId=new Uint8Array(16),otherSeed=new Uint8Array(16);
  for(const other of [mainnetIdentitySeeds(master,account,walletId),mainnetIdentitySeeds(master,factory,otherId),
    testIdentitySeeds(master,97,walletId),active])assert.notDeepEqual(other.skSeed,identity.skSeed);
  for(const other of [mainnetActiveSeeds(master,factory,walletId,account,2,pubSeed),
    mainnetActiveSeeds(master,factory,walletId,factory,1,pubSeed),mainnetActiveSeeds(master,account,walletId,account,1,pubSeed),
    mainnetActiveSeeds(master,factory,otherId,account,1,pubSeed),mainnetActiveSeeds(master,factory,walletId,account,1,otherSeed),
    testActiveSeeds(master,97,account,1,pubSeed)])assert.notDeepEqual(other.skSeed,active.skSeed);
  assert.throws(()=>testIdentitySeeds(master,56,walletId));
  assert.throws(()=>testActiveSeeds(master,56,account,1,pubSeed));
  assert.throws(()=>mainnetIdentitySeeds(new Uint8Array(16),factory,walletId));
  assert.throws(()=>mainnetActiveSeeds(master,factory,walletId,account,0,pubSeed));
  assert.throws(()=>mainnetActiveSeeds(master,factory,walletId,account,1,new Uint8Array(32)));
});
