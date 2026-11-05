// Disposable Anvil-only fixture. Never accepts an existing seed, backup or private key.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as E from '../ui/lib/evmwots.js';
import {createEnvelope,decryptPayload,encryptPayload,hex} from '../ui/vault-crypto.js';
import {fromHex} from '../ui/local-proof.js';
import {testIdentitySeeds,testActiveSeeds,TestSigningSession} from '../ui/test-wallet-core.js';
import {accountCodeHash} from '../ui/contract-pin.js';
import {keccak256} from '../ui/lib/keccak.js';
import {readAccount} from '../ui/account-state.js';
const endpoint='http://127.0.0.1:8950',chainId=31337,payer='0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const password='Public disposable account-check fixture';
const data=bytes=>'0x'+hex(bytes);let id=0;
async function rpc(method,params=[]){
  const current=++id,response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:current,method,params}),redirect:'error',signal:AbortSignal.timeout(12000)});
  const value=await response.json();assert.ok(response.ok&&value.jsonrpc==='2.0'&&value.id===current&&!value.error&&value.result!==undefined,'Local RPC failed');return value.result;
}
async function localOnly(){assert.equal(await rpc('eth_chainId'),'0x7a69');assert.match(await rpc('web3_clientVersion'),/anvil/i);}
await localOnly();assert.ok((await rpc('eth_accounts')).includes(payer));
const artifact=JSON.parse(readFileSync(new URL('../out/BscTestAccount.sol/BscTestAccount.json',import.meta.url)));
assert.equal(data(keccak256(fromHex(artifact.deployedBytecode.object.slice(2)))),accountCodeHash);
const runId=randomBytes(16).toString('hex'),directory=new URL('../demo-runs/'+runId+'/',import.meta.url);mkdirSync(directory,{recursive:true});
const {record:initial,key}=await createEnvelope(password,chainId);let record=initial;
const payload=await decryptPayload(record,key),master=fromHex(payload.seed);let identity,active;
const backup=new URL('account-check-vault.json',directory);
function save(){const fd=openSync(backup,'w');try{writeFileSync(fd,JSON.stringify(record,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
async function send(tx){
  await localOnly();const request={from:payer,...tx};const gas=BigInt(await rpc('eth_estimateGas',[request]));
  const hash=await rpc('eth_sendTransaction',[{...request,gas:'0x'+(gas*12n/10n+10000n).toString(16)}]);
  const until=Date.now()+45000;
  while(Date.now()<until){const receipt=await rpc('eth_getTransactionReceipt',[hash]);if(receipt){assert.equal(receipt.status,'0x1');return receipt;}await new Promise(resolve=>setTimeout(resolve,500));}
  throw new Error('Local receipt timeout; rerun with fresh fixture keys.');
}
try{
  console.log('Building disposable identity tree…');const seeds=testIdentitySeeds(master,chainId,fromHex(record.walletId));identity=E.EvmTreeKey.generate(seeds.skSeed,seeds.pubSeed);
  save();const deployment=await send({data:artifact.bytecode.object+hex(E.leftWord(identity.pubSeed))+hex(E.leftWord(identity.root))});const account=deployment.contractAddress;
  console.log('Building disposable active tree…');const activeSeeds=testActiveSeeds(master,chainId,account,1,randomBytes(16));active=E.EvmTreeKey.generate(activeSeeds.skSeed,activeSeeds.pubSeed);
  const signer=new TestSigningSession(async reservation=>{
    payload.journal.push({chainId,account,epoch:0,...reservation});record=await encryptPayload(payload,key,{...record,revision:record.revision+1});save();
  });
  const leaf=E.chainSlot(chainId),rnd=randomBytes(16),deadline=Number(BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp))+600;
  const candidate=E.grind(E.rekeyHasher(rnd,chainId,account,0,leaf,deadline,active.pubSeed,active.root),4096);
  const proof=await signer.sign(identity,leaf,candidate.digest);
  await send({to:account,data:data(E.encodeRekey(active.pubSeed,active.root,leaf,deadline,candidate.salt,rnd,proof))});
  const state=await readAccount({endpoint,account,chainId});assert.equal(state.epoch,1);assert.equal(state.root,data(active.root));
  const report={format:'aurven-account-check-fixture-v1',publicDisposableTestKeys:true,account,endpoint,chainId,root:state.root,epoch:1,backup:fileURLToPath(backup)};
  writeFileSync(new URL('public-report.json',directory),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report));console.log('Disposable fixture password: '+password);
  console.log('Import the backup into an empty test browser profile. It will stay read-only, even when its root matches.');
}finally{master.fill(0);identity?.skSeed.fill(0);active?.skSeed.fill(0);}
