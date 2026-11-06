import test from 'node:test';
import assert from 'node:assert/strict';
import {startLocalNode} from '../scripts/local-wallet-chain.mjs';
import {rehearseMainnet} from '../scripts/mainnet-rehearsal.mjs';
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
  assert.equal(seen.filter(m=>m==='eth_call').length,4);
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
