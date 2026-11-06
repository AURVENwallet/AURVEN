import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {accountRpc} from '../ui/account-state.js';
import {startLocalNode} from '../scripts/local-wallet-chain.mjs';
import {cast,prepareBundle,validateBundle} from '../scripts/pilot-bundle.mjs';
import {submitBundle} from '../scripts/testnet-pilot.mjs';

test('pilot refuses other chains before reading files, signing or sending',async()=>{
  const rpc=async method=>{assert.equal(method,'eth_chainId');return '0x38';};
  const payer='0x'+'11'.repeat(20);
  await assert.rejects(prepareBundle({rpc,payer}),/chain 97/);
  await assert.rejects(submitBundle({rpc,payer}),/chain 97/);
});

test('recover a lost transfer reply and replay the identical bytes after a rollback',{timeout:180000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'aurven-pilot-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const node=await startLocalNode(undefined,0,97);
  t.after(()=>node.close());
  const rpc=accountRpc(node.endpoint), keystore=join(dir,'payer.keystore'), passwordFile=join(dir,'password');
  const password=randomBytes(32).toString('hex');
  await writeFile(passwordFile,password,{mode:0o600});
  execFileSync('cast',['wallet','new',dir,'payer.keystore'],{env:{...process.env,CAST_PASSWORD:password},stdio:'ignore'});
  const payer=cast(['wallet','address','--keystore',keystore,'--password-file',passwordFile]).toLowerCase();
  await assert.rejects(prepareBundle({dir,rpc,payer,keystore,passwordFile}),/Faucet tBNB/);
  await rpc('anvil_setBalance',[payer,'0xde0b6b3a7640000']);
  const bundle=await prepareBundle({dir,rpc,payer,keystore,passwordFile});
  const signed=await readFile(join(dir,'signed.json'),'utf8');
  const files=await readdir(dir);
  assert.equal(files.filter(name=>name.startsWith('spent-')).length,2);
  assert.deepEqual(await prepareBundle({dir,rpc,payer}),bundle);
  const altered=structuredClone(bundle);altered.transactions.reverse();
  await assert.rejects(validateBundle(altered,payer));
  const prepared={endpoint:node.endpoint,dir,payer,confirmations:1};
  const sends=[];
  let snapshot;
  async function lostReply(method,params) {
    if (method!=='eth_sendRawTransaction') return rpc(method,params);
    sends.push(params[0]);
    if (params[0]===bundle.transactions[3].raw) {
      snapshot=await rpc('evm_snapshot');
      await rpc(method,params);
      throw new Error('Dropped connection after acceptance');
    }
    return rpc(method,params);
  }
  await assert.rejects(submitBundle({...prepared,rpc:lostReply}),/outcome unknown for transfer/);
  assert.deepEqual(sends,bundle.transactions.map(tx=>tx.raw));
  const report=await submitBundle({...prepared,rpc:(method,params)=>{
    assert.notEqual(method,'eth_sendRawTransaction');return rpc(method,params);
  }});
  assert.equal(report.finalState.nextLeaf,1);
  assert.equal(report.finalState.balanceWei,'0');
  assert.equal(await rpc('evm_revert',[snapshot]),true);
  const beforeRetry=await rpc('evm_snapshot');
  const replayed=[];
  const again=await submitBundle({...prepared,rpc:(method,params)=>{
    if (method==='eth_sendRawTransaction') replayed.push(params[0]);
    return rpc(method,params);
  }});
  assert.deepEqual(replayed,[bundle.transactions[3].raw]);
  assert.deepEqual(again.receipts.map(row=>row.hash),report.receipts.map(row=>row.hash));
  assert.equal(await rpc('evm_revert',[beforeRetry]),true);
  await rpc('evm_setNextBlockTimestamp',[bundle.deadline+1]);await rpc('evm_mine');
  const realNow=Date.now.bind(Date);
  const clockOffset=(bundle.deadline+1)*1000-realNow();
  t.mock.method(Date,'now',()=>realNow()+clockOffset);
  await assert.rejects(submitBundle({...prepared,rpc:(method,params)=>{
    assert.notEqual(method,'eth_sendRawTransaction');return rpc(method,params);
  }}),/Expired bundle/);
  assert.equal(await readFile(join(dir,'signed.json'),'utf8'),signed);
  assert.deepEqual(await readdir(dir),files);
});
