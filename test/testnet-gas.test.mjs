import test from 'node:test';
import assert from 'node:assert/strict';
import {measureTestnetGas} from '../scripts/testnet-gas.mjs';
import {startLocalNode} from '../scripts/local-wallet-chain.mjs';
import {accountRpc} from '../ui/account-state.js';
import {accountCodeHash} from '../ui/contract-pin.js';

test('refuses mainnet before reading contract or block data',async()=>{
  const methods=[];
  await assert.rejects(measureTestnetGas(async method=>{methods.push(method);return '0x38';}),/chain ID 97/);
  assert.deepEqual(methods,['eth_chainId']);
});

test('replays each estimated call at its quoted gas without persistent testnet state',async t=>{
  const node = await startLocalNode(undefined,0,97);
  t.after(()=>node.close());
  const rpc = accountRpc(node.endpoint);
  const before = await rpc('eth_getBlockByNumber',['latest',false]);
  const readOnly = ['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_getBalance',
    'eth_getTransactionCount','eth_estimateGas','eth_call'];
  const executions = [];
  const checkedRpc = (method,params=[])=>{
    assert.ok(readOnly.includes(method));
    if (method==='eth_call' && params[0].gas) executions.push(params);
    return rpc(method,params);
  };
  const report = await measureTestnetGas(checkedRpc,before.number);
  assert.equal(report.blockHash,before.hash);
  assert.equal(report.runtimeHash,accountCodeHash);
  assert.equal(executions.length,3);
  for (const [index,operation] of ['deployment','transfer','rotation'].entries()) {
    assert.equal(BigInt(executions[index][0].gas).toString(),report[operation].estimateGas);
    assert.equal(executions[index][1],before.number);
  }
  const [transfer,block,overrides] = executions[1];
  assert.equal(await rpc('eth_getCode',[transfer.to,'latest']),'0x');
  assert.equal(await rpc('eth_getBalance',[transfer.to,'latest']),'0x0');
  const tampered = transfer.data.slice(0,-2)+'00';
  assert.notEqual(tampered,transfer.data);
  await assert.rejects(rpc('eth_call',[{to:transfer.to,data:tampered},block,overrides]));
  assert.equal((await rpc('eth_getBlockByNumber',['latest',false])).hash,before.hash);
  await assert.rejects(measureTestnetGas((method,params)=>{
    if (method==='eth_call' && params.length===3) return '0x';
    return rpc(method,params);
  }),/overrides/);
});
