import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {startLocalNode} from '../scripts/local-wallet-chain.mjs';
import {accountRpc} from '../ui/account-state.js';
import {createdAddress,payerAccount,previewTrial,recoverTrial} from '../ui/browser-trial.js';
import {buildTrialData} from '../ui/browser-trial-sign.js';
import {spendTrialLeaf} from '../ui/browser-trial-store.js';
import {submitTrial} from '../ui/browser-trial-submit.js';

test('refuses mainnet before connecting and predicts creation addresses across nonce encodings',async()=>{
  const payer='0x'+'11'.repeat(20);
  await assert.rejects(payerAccount({request:({method})=>{assert.equal(method,'eth_chainId');return '0x38';}},true),/TRIAL_CHAIN/);
  for (const nonce of [0,1,127,128,255,256]) {
    const output=execFileSync('cast',['compute-address',payer,'--nonce',String(nonce)],{encoding:'utf8'});
    assert.ok(output.toLowerCase().includes(createdAddress(payer,nonce)));
  }
});

test('browser authorization transfers one wei once and recovers a lost wallet reply from chain logs',{timeout:180000},async t=>{
  const node=await startLocalNode(undefined,0,97);t.after(()=>node.close());
  const endpoint=node.endpoint,rpc=accountRpc(endpoint);
  const payer='0x'+randomBytes(20).toString('hex'),recipient='0x'+randomBytes(20).toString('hex');
  await rpc('anvil_setBalance',[payer,'0xde0b6b3a7640000']);await rpc('anvil_impersonateAccount',[payer]);
  const plan=await previewTrial(rpc,payer,recipient);
  let saved=null,hash;
  const store={read:async()=>structuredClone(saved),create:async next=>{assert.equal(saved,null);saved=structuredClone(next);},
    compareAndSwap:async(old,next)=>{assert.deepEqual(saved,old);saved=structuredClone(next);}};
  const provider={request:async({method,params})=>{
    if (method==='eth_accounts') return [payer];
    if (method==='eth_sendTransaction') {
      assert.equal(saved.rows[0].status,'requested');
      assert.equal(saved.rows[0].reservations.length,2);
      await rpc('eth_call',[params[0],'latest']);
      hash=await rpc(method,params);throw new Error('connection lost');
    }
    assert.equal(method,'eth_chainId');return '0x61';
  }};
  const bytecode=JSON.parse(await readFile(new URL('../ui/assets/browser-trial-init.json',import.meta.url)));
  const build=input=>buildTrialData(input,bytecode,row=>spendTrialLeaf(store,input.id,row));
  await assert.rejects(submitTrial({store,rpc,provider,plan,build}),/TRIAL_REPLY/);
  const row=structuredClone(saved.rows[0]);
  let receipt;
  for (let i=0;i<40 && !receipt;i++) {
    receipt=await rpc('eth_getTransactionReceipt',[hash]);
    if (!receipt) await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(receipt?.status,'0x1');
  assert.equal(row.hash,undefined);assert.equal(row.reservations.length,2);assert.equal(row.reservations[1].leaf,0);
  const found=await recoverTrial(endpoint,rpc,row);
  assert.equal(found.status,'included');assert.equal(found.hash,hash);
  assert.ok(BigInt(found.gasUsed)<BigInt(plan.gas));
  assert.equal(await rpc('eth_getBalance',[recipient,'latest']),'0x1');
  assert.equal(await rpc('eth_getBalance',[plan.account,'latest']),'0x0');
  assert.deepEqual(await recoverTrial(endpoint,rpc,{...row,hash}),found);
  const limitedRpc=(method,params)=>{
    if (method==='eth_getLogs') throw new Error('limit exceeded');
    return rpc(method,params);
  };
  assert.deepEqual(await recoverTrial(endpoint,limitedRpc,row),found);
  await assert.rejects(recoverTrial(endpoint,rpc,{...row,dataHash:'0x'+'00'.repeat(32)},hash),/TRIAL_HASH/);
  await assert.rejects(submitTrial({store,rpc,provider,plan,build:()=>assert.fail('second signature')}),/TRIAL_NONCE/);
});
