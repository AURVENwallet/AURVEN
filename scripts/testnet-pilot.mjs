import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';
import {accountRpc,readAccount} from '../ui/account-state.js';
import {checkTransaction} from '../ui/activity-rpc.js';
import {prepareBundle,stages,validateBundle} from './pilot-bundle.mjs';

const endpoint97='https://bsc-testnet.bnbchain.org';
async function checkState(endpoint,bundle,stage) {
  const state=await readAccount({endpoint,account:bundle.account,chainId:97});
  const identity=stage==='activate', key=identity?bundle.identity:bundle.active;
  assert.equal(state.pubSeed,key.seed);assert.equal(state.root,key.root);
  assert.equal(state.epoch,identity?0:1);assert.equal(state.next,stage==='complete'?1:0);
  assert.equal(state.balanceWei,stage==='transfer'?'1':'0','Unexpected test-account balance');
  return state;
}

// Submission can only reload an already committed bundle. It has no signer or keystore input.
export async function submitBundle({endpoint=endpoint97,rpc=accountRpc(endpoint),dir,payer,confirmations=3,timeoutMs=45000}) {
  assert.equal(await rpc('eth_chainId'),'0x61','BSC testnet chain 97 required');
  const bundle=JSON.parse(await readFile(join(dir,'signed.json'),'utf8'));
  await validateBundle(bundle,payer);
  assert.equal((await rpc('eth_getBlockByNumber',['0x0',false])).hash,bundle.genesis,'Different chain genesis');
  const receipts=[];
  for (const [index,stage] of stages.entries()) {
    const {hash,raw}=bundle.transactions[index];
    const receipt=()=>rpc('eth_getTransactionReceipt',[hash]);
    let found=await receipt();
    if (!found && !await rpc('eth_getTransactionByHash',[hash])) {
      const head=await rpc('eth_getBlockByNumber',['latest',false]);
      assert.ok(BigInt(head.timestamp)<BigInt(bundle.deadline),'Expired bundle. Stop and inspect existing receipts.');
      assert.equal(BigInt(await rpc('eth_getTransactionCount',[payer,'pending'])),BigInt(index),
        'Payer nonce already occupied. Recheck this saved hash before taking further action.');
      if (stage!=='create') await checkState(endpoint,bundle,stage);
      assert.equal(await rpc('eth_chainId'),'0x61','Network changed before submission');
      try {
        const sent=await rpc('eth_sendRawTransaction',[raw]);
        if (sent?.toLowerCase()!==hash) throw new Error('Unexpected transaction hash');
      } catch {
        throw new Error('Submission outcome unknown for '+stage+' '+hash+'. Run submit again with this same bundle.');
      }
    }
    const until=Date.now()+timeoutMs;
    let observed;
    while (Date.now()<until) {
      found=await receipt();
      if (found) {
        try {observed=await checkTransaction({endpoint,chainId:97,account:bundle.account,hash});}
        catch (error) {
          // A load-balanced RPC can see a receipt ahead of the head it just returned.
          // Retry the entire read; none of this evidence can trigger another send.
          if (!['INVALID_RESPONSE','CHANGED_DURING_READ','NOT_IN_BLOCK'].includes(error.message)) throw error;
          observed=undefined;
        }
        if (observed?.status==='reverted') throw new Error(stage+' reverted: '+hash+'. The leaf remains consumed.');
        if (observed?.status==='included' && found.blockHash===observed.inclusion.blockHash &&
            BigInt(observed.inclusion.confirmations)>=BigInt(confirmations)) break;
      }
      await wait(500);
    }
    assert.ok(observed?.status==='included' && BigInt(observed.inclusion.confirmations)>=BigInt(confirmations),
      'Awaiting canonical receipt for '+stage+' '+hash+'. Resume with submit.');
    assert.equal(found.from.toLowerCase(),payer);
    assert.equal(found.blockHash,observed.inclusion.blockHash);
    if (stage==='transfer') assert.deepEqual(observed.inclusion.executions,[{epoch:1,leaf:0,digest:bundle.transfer.digest}]);
    receipts.push({stage,hash,blockNumber:found.blockNumber,blockHash:found.blockHash,
      gasUsed:BigInt(found.gasUsed).toString(),feeWei:observed.inclusion.feeWei});
  }
  const state=await checkState(endpoint,bundle,'complete');
  for (const row of receipts) {
    const canonical=await rpc('eth_getBlockByNumber',[row.blockNumber,false]);
    assert.equal(canonical?.hash,row.blockHash,'Chain changed during the pilot. Recheck saved transactions.');
  }
  return {chainId:97,payer,account:bundle.account,recipient:payer,transferredWei:'1',
    finalState:{epoch:state.epoch,nextLeaf:state.next,balanceWei:state.balanceWei,codeHash:state.codeHash},receipts};
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href===import.meta.url) {
  try {
    const [command,address]=process.argv.slice(2), payer=address?.toLowerCase();
    assert.ok(['prepare','submit'].includes(command) && /^0x[0-9a-f]{40}$/.test(payer),
      'Use prepare or submit followed by the dedicated testnet payer address.');
    const dir=fileURLToPath(new URL('../demo-runs/testnet97/'+payer+'/',import.meta.url));
    if (command==='prepare') {
      const bundle=await prepareBundle({rpc:accountRpc(endpoint97),dir,payer,keystore:process.env.ETH_KEYSTORE,passwordFile:process.env.ETH_PASSWORD});
      console.log(JSON.stringify({account:bundle.account,deadline:bundle.deadline,hashes:bundle.transactions.map(tx=>tx.hash)},null,2));
    } else console.log(JSON.stringify(await submitBundle({dir,payer}),null,2));
  } catch (error) {
    console.error(String(error.message).split('\n')[0]);
    process.exitCode=1;
  }
}
