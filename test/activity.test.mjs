import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {checkTransaction} from '../ui/activity-rpc.js';
import {associate,accountKey,addHash,beginCheck,finishCheck,publicReport,MAX_TRANSACTIONS} from '../ui/activity-store.js';
import {accountCodeHash} from '../ui/contract-pin.js';
import {keccak256} from '../ui/lib/keccak.js';
import {translateText} from '../ui/i18n-copy.js';
const account='0x'+'11'.repeat(20),from='0x'+'22'.repeat(20),hash='0x'+'33'.repeat(32),blockHash='0x'+'44'.repeat(32),headHash='0x'+'55'.repeat(32);
const state={account,chainId:31337,codeHash:accountCodeHash,epoch:2,next:1,root:'0x'+'66'.repeat(16),pubSeed:'0x'+'77'.repeat(16),blockNumber:'0x9',blockHash};
const topic='0x'+Buffer.from(keccak256(new TextEncoder().encode('Executed(uint32,uint32,bytes16)'))).toString('hex');
const word=n=>BigInt(n).toString(16).padStart(64,'0');
function fixture(){
  const head={number:'0xa',hash:headHash,timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),transactions:[]};
  const block={...head,number:'0x9',hash:blockHash,transactions:[hash]};
  const tx={hash,from,to:account,chainId:'0x7a69',blockNumber:'0x9',blockHash};
  const receipt={transactionHash:hash,from,to:account,contractAddress:null,status:'0x1',blockNumber:'0x9',blockHash,gasUsed:'0x64',effectiveGasPrice:'0x2',logs:[
    {address:account,transactionHash:hash,blockNumber:'0x9',blockHash,removed:false,topics:[topic,'0x'+word(2)],data:'0x'+word(0)+'88'.repeat(16)+'00'.repeat(16)}]};
  return {head,block,tx,receipt,chain:'0x7a69'};
}
async function check(t,change=()=>{},previous=null){
  const data=fixture();change(data);const calls=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    const request=JSON.parse(options.body);calls.push(request);
    let result;
    if(request.method==='eth_chainId')result=data.chain;
    else if(request.method==='eth_getTransactionByHash')result=data.tx;
    else if(request.method==='eth_getTransactionReceipt')result=data.receipt;
    else if(request.method==='eth_getBlockByNumber'){
      result=request.params[0]==='0x9'?data.block:data.head;
      if(data.transform)result=data.transform(request,result,calls);
    }else assert.fail('Unexpected RPC method: '+request.method);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}));
  });
  return checkTransaction({endpoint:'http://127.0.0.1:8950',chainId:31337,account,hash,previous});
}
test('included transaction matches account, receipt and canonical block; events and fee decoded',async t=>{
  const result=await check(t);assert.equal(result.status,'included');assert.equal(result.inclusion.confirmations,'2');assert.equal(result.inclusion.feeWei,'200');
  assert.deepEqual(result.inclusion.executions,[{epoch:2,leaf:0,digest:'0x'+'88'.repeat(16)}]);
});
test('reverted receipt remains a separate outcome, without execution events',async t=>{
  const result=await check(t,data=>{data.receipt.status='0x0';data.receipt.logs=[];});assert.equal(result.status,'reverted');
});
test('pending transaction has no inclusion or success claim',async t=>{
  const result=await check(t,data=>{data.receipt=null;data.tx.blockNumber=null;data.tx.blockHash=null;});assert.equal(result.status,'pending');assert.equal(result.inclusion,undefined);
});
test('missing transaction is unknown, not failed',async t=>{
  assert.equal((await check(t,data=>{data.tx=null;data.receipt=null;})).status,'unknown');
});
test('missing prior receipt preserves uncertainty after previous inclusion',async t=>{
  assert.equal((await check(t,data=>{data.tx=null;data.receipt=null;},{blockHash})).status,'unavailable');
});
test('mined transaction without receipt is unavailable',async t=>{
  assert.equal((await check(t,data=>{data.receipt=null;})).status,'unavailable');
});
test('network mismatch fails before a success observation',async t=>{
  await assert.rejects(check(t,data=>{data.chain='0x38';}),/NETWORK/);
});
test('unrelated account is rejected',async t=>{
  await assert.rejects(check(t,data=>{data.tx.to=from;data.receipt.to=from;}),/ACCOUNT_MISMATCH/);
});
test('creation receipt must bind the watched contract address',async t=>{
  const result=await check(t,data=>{data.tx.to=null;data.receipt.to=null;data.receipt.contractAddress=account;});assert.equal(result.status,'included');
});
test('pending creation without an observed address cannot bind a watched account',async t=>{
  await assert.rejects(check(t,data=>{data.tx.to=null;data.tx.blockHash=null;data.tx.blockNumber=null;data.receipt=null;}),/ACCOUNT_UNVERIFIED/);
});
test('receipt mismatch is rejected even with a successful status',async t=>{
  await assert.rejects(check(t,data=>{data.receipt.transactionHash=headHash;}),/INVALID_RESPONSE/);
});
test('canonical block mismatch is shown as a block change',async t=>{
  assert.equal((await check(t,data=>{data.block.hash=headHash;})).status,'reorg');
});
test('receipt is insufficient when the block omits the transaction',async t=>{
  await assert.rejects(check(t,data=>{data.block.transactions=[];}),/NOT_IN_BLOCK/);
});
test('head changed during observation cannot produce a success result',async t=>{
  await assert.rejects(check(t,data=>{data.transform=(request,block)=>request.params[0]==='0xa'?{...block,hash:blockHash}:block;}),/CHANGED_DURING_READ/);
});
test('stale node responses are rejected',async t=>{
  await assert.rejects(check(t,data=>{data.head.timestamp='0x1';}),/STALE_NODE/);
});
test('invalid execution log padding is rejected',async t=>{
  await assert.rejects(check(t,data=>{data.receipt.logs[0].data+='00';}),/INVALID_RESPONSE/);
});
test('a re-included transaction explicitly records its changed block',async t=>{
  assert.equal((await check(t,()=>{},{blockHash:headHash})).relocated,true);
});
test('oversized RPC responses are canceled instead of parsed',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('x'.repeat(1048577)));
  await assert.rejects(checkTransaction({endpoint:'https://example.test',chainId:97,account,hash}),/RESPONSE_TOO_LARGE/);
});
test('association persists only public allowlisted fields and pins account version',()=>{
  const record=associate({...state,endpoint:'https://example.test/private-provider-token',seed:'private-test-marker'});
  assert.equal(record.key,accountKey(31337,account));assert.doesNotMatch(JSON.stringify(record),/private-/);
  assert.throws(()=>associate({...state,codeHash:hash}),/INPUT/);assert.throws(()=>accountKey(56,account),/INPUT/);
});
test('transaction hashes deduplicate and respect the per-account limit',()=>{
  let record=addHash(associate(state),hash);assert.equal(addHash(record,hash.toUpperCase().replace('0X','0x')).transactions.length,1);
  for(let i=1;i<MAX_TRANSACTIONS;i++)record=addHash(record,'0x'+word(i));
  assert.throws(()=>addHash(record,'0x'+word(10000)),/LIMIT/);
});
test('late checks from an older tab cannot overwrite a newer check',()=>{
  let record=addHash(associate(state),hash);record=beginCheck(record,hash,'first');record=beginCheck(record,hash,'second');
  const saved=finishCheck(record,hash,'second',{status:'pending'});
  assert.deepEqual(finishCheck(saved,hash,'first',{status:'included'}),saved);
});
test('failure retains previous block evidence without retaining a current success status',()=>{
  let record=beginCheck(addHash(associate(state),hash),hash,'first');
  record=finishCheck(record,hash,'first',{status:'included',inclusion:{blockNumber:'0x9',blockHash}});
  record=finishCheck(beginCheck(record,hash,'second'),hash,'second',{status:'error',error:'RPC_UNAVAILABLE'});
  assert.equal(record.transactions[0].status,'error');assert.equal(record.transactions[0].previous.blockHash,blockHash);
  assert.equal(record.transactions[0].result.inclusion,undefined);
});
test('public exports omit internal request tokens and do not assert ownership',()=>{
  const record=beginCheck(addHash(associate(state),hash),hash,'private-request-token');
  const report=publicReport([record]);assert.equal(report.ownershipVerified,false);assert.equal(report.accounts[0].transactions[0].status,'unchecked');
  assert.doesNotMatch(JSON.stringify(report),/private-request-token|"endpoint"|"seed"|"password"/i);
});
test('tracker does not import vault access or signing code',()=>{
  for(const name of ['activity-rpc','activity-store','activity-ui']){
    const code=readFileSync(new URL('../ui/'+name+'.js',import.meta.url),'utf8');
    assert.doesNotMatch(code,/from ['"][^'"]*(?:vault|proof-worker|signer)|eth_send|reserveLeaf/);
  }
});
test('all tracker status strings and static labels have English copy',()=>{
  const code=readFileSync(new URL('../ui/activity-ui.js',import.meta.url),'utf8');
  for(const match of code.matchAll(/'([^'\n]*[\u3400-\u9fff][^'\n]*)'/g))assert.doesNotMatch(translateText(match[1],'en'),/[\u3400-\u9fff]/,match[1]);
});
