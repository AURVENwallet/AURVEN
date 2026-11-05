// Disposable local chain exercise: never reads a user's seed or EOA private key.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync,renameSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import * as E from '../ui/lib/evmwots.js';
import {keccak256} from '../ui/lib/keccak.js';
import {hex,testIdentitySeeds,testActiveSeeds,TestSigningSession} from '../ui/test-wallet-core.js';
import {readAccount} from '../ui/account-state.js';
import {accountCodeHash} from '../ui/contract-pin.js';

const endpoint='http://127.0.0.1:8950',chainId=31337;
const payer='0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const recipient='0x2222222222222222222222222222222222222222';
const chainHex='0x7a69',q=n=>'0x'+BigInt(n).toString(16),data=b=>'0x'+hex(b);
let requestId=0;
async function rpc(method,params=[]){
  const id=++requestId;
  const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(15000),redirect:'error'});
  const result=await response.json();
  if(!response.ok||result.id!==id||result.jsonrpc!=='2.0')throw new Error('Invalid local RPC response');
  if(result.error){const error=new Error(result.error.message);error.rpc=result.error;throw error;}
  if(result.result===undefined)throw new Error('Missing local RPC result');
  return result.result;
}
async function localOnly(){
  assert.equal(await rpc('eth_chainId'),chainHex,'Only chain 31337 is permitted');
  assert.match(await rpc('web3_clientVersion'),/anvil/i,'Only local Anvil is permitted');
}
await localOnly();
assert.ok((await rpc('eth_accounts')).map(a=>a.toLowerCase()).includes(payer),'Default local test payer missing');
const artifact=JSON.parse(readFileSync(new URL('../out/BscTestAccount.sol/BscTestAccount.json',import.meta.url)));
assert.equal(data(keccak256(Buffer.from(artifact.deployedBytecode.object.slice(2),'hex'))),accountCodeHash,'Rebuild and pin the contract before running');
const runId=randomBytes(16).toString('hex');
const runs=new URL('../demo-runs/'+runId+'/',import.meta.url);mkdirSync(runs,{recursive:true});
const publicMaster=randomBytes(32),walletId=randomBytes(16);
writeFileSync(new URL('PUBLIC-TEST-KEYS.json',runs),JSON.stringify({warning:'DISPOSABLE LOCAL TEST KEYS. NEVER USE WITH REAL ASSETS.',runId,master:hex(publicMaster),walletId:hex(walletId)},null,2),{flag:'wx'});
const journal=openSync(new URL('reservations.jsonl',runs),'wx');
const signer=new TestSigningSession(record=>{writeSync(journal,JSON.stringify({runId,...record})+'\n');fsyncSync(journal);});
const steps=[],checks=[],timings={};
async function send(stage,tx){
  await localOnly();
  const request={from:payer,...tx};
  const estimate=BigInt(await rpc('eth_estimateGas',[request]));
  const hash=await rpc('eth_sendTransaction',[{...request,gas:q(estimate*12n/10n+10000n)}]);
  let receipt;
  const until=Date.now()+45000;
  while(Date.now()<until){
    receipt=await rpc('eth_getTransactionReceipt',[hash]);
    if(receipt)break;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  assert.ok(receipt,'Receipt timed out; a fresh run must use fresh keys');
  assert.equal(receipt.status,'0x1',stage+' reverted');
  const gasUsed=BigInt(receipt.gasUsed),gasPrice=BigInt(receipt.effectiveGasPrice);
  steps.push({stage,hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,
    from:payer,to:tx.to??null,contractAddress:receipt.contractAddress,
    valueWei:BigInt(tx.value??0).toString(),gasUsed:gasUsed.toString(),gasPriceWei:gasPrice.toString(),feeWei:(gasUsed*gasPrice).toString()});
  console.log(stage+': confirmed, gas='+gasUsed);
  return receipt;
}
async function rejects(label,tx,errorName){
  const expected=data(keccak256(new TextEncoder().encode(errorName+'()'))).slice(0,10);
  await assert.rejects(rpc('eth_call',[{from:payer,...tx},'latest']),error=>{
    const details=JSON.stringify(error.rpc??{}).toLowerCase();
    return details.includes(expected.toLowerCase());
  },label+' must fail with '+errorName);
  checks.push({name:label,error:errorName,passed:true});console.log('Rejected as expected: '+label);
}
function tree(seeds,label){
  const started=Date.now();console.log('Building '+label+' (1024 leaves)…');
  const result=E.EvmTreeKey.generate(seeds.skSeed,seeds.pubSeed);
  timings[label]=Date.now()-started;return result;
}
const timestamp=async()=>Number(BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp));
try{
  const identity=tree(testIdentitySeeds(publicMaster,chainId,walletId),'identity');
  const deployment=await send('create',{data:artifact.bytecode.object+hex(E.leftWord(identity.pubSeed))+hex(E.leftWord(identity.root))});
  const account=deployment.contractAddress;
  let state=await readAccount({endpoint,account,chainId});assert.equal(state.epoch,0);
  const active=tree(testActiveSeeds(publicMaster,chainId,account,1,randomBytes(16)),'active');
  const next=tree(testActiveSeeds(publicMaster,chainId,account,2,randomBytes(16)),'rotated');
  async function rekey(old,target,epoch,leaf,stage){
    const rnd=randomBytes(16),deadline=await timestamp()+600;
    const g=E.grind(E.rekeyHasher(rnd,chainId,account,epoch,leaf,deadline,target.pubSeed,target.root),4096);
    const proof=await signer.sign(old,leaf,g.digest);
    const calldata=data(E.encodeRekey(target.pubSeed,target.root,leaf,deadline,g.salt,rnd,proof));
    await rpc('eth_call',[{from:payer,to:account,data:calldata},'latest']);
    await send(stage,{to:account,data:calldata});
    return calldata;
  }
  await rekey(identity,active,0,E.chainSlot(chainId),'bootstrap');
  state=await readAccount({endpoint,account,chainId});assert.equal(state.epoch,1);assert.equal(state.next,0);
  await send('fund',{to:account,value:q(10n**18n)});
  async function transfer(key,epoch,amount,stage,negativeChecks=false){
    const rnd=randomBytes(16),deadline=await timestamp()+600,leaf=0;
    const calls=[{to:recipient,value:amount,data:new Uint8Array()}];
    const g=E.grind(E.execHasher(rnd,chainId,account,epoch,leaf,deadline,calls),4096);
    const proof=await signer.sign(key,leaf,g.digest);
    const calldata=data(E.encodeExecute(calls,leaf,deadline,g.salt,rnd,proof));
    if(negativeChecks){
      const bad=proof.slice();bad[0]^=1;
      await rejects('tampered-proof',{to:account,data:data(E.encodeExecute(calls,leaf,deadline,g.salt,rnd,bad))},'BadSignature');
      const changed=[{...calls[0],to:'0x3333333333333333333333333333333333333333'}];
      await rejects('changed-recipient',{to:account,data:data(E.encodeExecute(changed,leaf,deadline,g.salt,rnd,proof))},'BadSignature');
    }
    const beforeAccount=BigInt(await rpc('eth_getBalance',[account,'latest']));
    const beforeRecipient=BigInt(await rpc('eth_getBalance',[recipient,'latest']));
    await rpc('eth_call',[{from:payer,to:account,data:calldata},'latest']);
    await send(stage,{to:account,data:calldata});
    assert.equal(BigInt(await rpc('eth_getBalance',[account,'latest'])),beforeAccount-amount);
    assert.equal(BigInt(await rpc('eth_getBalance',[recipient,'latest'])),beforeRecipient+amount);
    return calldata;
  }
  const oldTransfer=await transfer(active,1,10n**16n,'transfer',true);
  state=await readAccount({endpoint,account,chainId});assert.equal(state.next,1);
  await rejects('replay',{to:account,data:oldTransfer},'LeafUsed');
  await rekey(active,next,1,1,'rotate');
  await rejects('old-root-after-rotation',{to:account,data:oldTransfer},'BadSignature');
  await transfer(next,2,5n*10n**15n,'transfer-after-rotation');
  state=await readAccount({endpoint,account,chainId});assert.equal(state.epoch,2);assert.equal(state.next,1);
  assert.equal(state.balanceWei,'985000000000000000');
  const report={format:'aurven-local-demo-v1',runId,chainId,account,payer,recipient,
    createdAt:new Date().toISOString(),publicTestKeys:true,codeHash:accountCodeHash,
    fundedWei:'1000000000000000000',transferredWei:'15000000000000000',state,steps,checks,timings,
    totalGas:steps.reduce((sum,s)=>sum+BigInt(s.gasUsed),0n).toString(),
    totalFeeWei:steps.reduce((sum,s)=>sum+BigInt(s.feeWei),0n).toString()};
  const reportText=JSON.stringify(report,null,2)+'\n';
  writeFileSync(new URL('report.json',runs),reportText,{flag:'wx'});
  const uiDir=new URL('../ui/demo/',import.meta.url);mkdirSync(uiDir,{recursive:true});
  const temporary=new URL('local-demo.'+runId+'.tmp',uiDir);
  writeFileSync(temporary,reportText,{flag:'wx'});renameSync(temporary,new URL('local-demo.json',uiDir));
  console.log('PASS: create → bootstrap → transfer → rotate → transfer; 4 rejection checks.');
  console.log('Demo account: '+account);console.log('Balance: 0.985 local test coins; epoch 2; next leaf 1.');
}finally{closeSync(journal);publicMaster.fill(0);}
