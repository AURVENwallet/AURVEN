import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {randomBytes} from 'node:crypto';
import {accountRpc,readAccount} from '../ui/account-state.js';
import {accountCodeHash} from '../ui/contract-pin.js';
import {deriveAccountRoot} from '../ui/account-key-engine.js';
import {signLocalTransfer} from '../ui/local-transfer.js';
import {prepareTransfer} from '../ui/transfer.js';
import {createEnvelope,decryptPayload} from '../ui/vault-crypto.js';
import {TestVault} from '../ui/vault-service.js';

test('real Anvil accepts the reserved signature in simulation without mining a transfer',{timeout:180000},async t=>{
  const artifact = JSON.parse(await readFile(new URL('../out/BscTestAccount.sol/BscTestAccount.json',import.meta.url)));
  // Only configure the process we started, using the port it actually bound.
  const node = spawn('anvil',['--host','127.0.0.1','--port','0','--accounts','0','--chain-id','31337','--color','never'],
    {windowsHide:true,stdio:['ignore','pipe','ignore']});
  t.after(()=>{node.kill();});
  const ready = new Promise((resolve,reject)=>{
    const timer = setTimeout(()=>reject(new Error('Local Anvil startup timed out')),15000);
    const lines = createInterface({input:node.stdout});
    lines.on('line',line=>{
      const match = /^Listening on (127\.0\.0\.1:\d+)$/.exec(line.trim());
      if (match) { clearTimeout(timer);resolve('http://'+match[1]+'/'); }
    });
    node.once('exit',()=>{clearTimeout(timer);reject(new Error('Local Anvil exited'));});
    node.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  const endpoint = await ready, chainId = 31337, account = '0x'+randomBytes(20).toString('hex');
  const rpc = accountRpc(endpoint);
  assert.equal(await rpc('eth_chainId'),'0x7a69');
  const password = randomBytes(24).toString('hex');
  const {record,key} = await createEnvelope(password,chainId);
  const snapshot = {account,chainId,codeHash:accountCodeHash,pubSeed:'0x'+randomBytes(16).toString('hex'),
    root:'0x'+'00'.repeat(16),epoch:1,next:0,blockHash:'0x'+'00'.repeat(32),blockNumber:'0x0',timestamp:Math.floor(Date.now()/1000)};
  const {root} = await deriveAccountRoot({record,key,snapshot});
  const word = n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
  await rpc('anvil_setCode',[account,artifact.deployedBytecode.object]);
  await rpc('anvil_setStorageAt',[account,word(0),root+snapshot.pubSeed.slice(2)]);
  await rpc('anvil_setStorageAt',[account,word(1),word(1n<<32n)]);
  await rpc('anvil_setBalance',[account,'0xde0b6b3a7640000']);
  await rpc('evm_mine');
  let saved = record;
  const store = {name:'ephemeral-test',read:async()=>structuredClone(saved),compareAndSwap:async(expected,updated)=>{
    assert.deepEqual(saved,expected);saved=structuredClone(updated);
  }};
  const client = engine=>({request:(_type,input)=>engine(input),dispose(){}});
  const vault = new TestVault(store,{locks:{request:(_name,_options,action)=>action({})},
    bindingWorkerFactory:()=>client(deriveAccountRoot),transferWorkerFactory:()=>client(signLocalTransfer)});
  t.after(()=>vault.lock());
  await vault.unlock(password);
  assert.equal((await vault.checkAccountKeys({account,endpoint})).matched,true);
  const state = await readAccount({endpoint,account,chainId});
  const recipient = '0x'+randomBytes(20).toString('hex');
  const tx = prepareTransfer({account,chainId,recipient,amount:'0.1',epoch:state.epoch,leaf:state.next,
    deadline:state.timestamp+600,randomizer:randomBytes(16)});
  const draft = {format:'bsc-key-lab-unsigned-transfer-v2',stateSource:'rpc-snapshot',...tx,snapshot:state,leafReserved:false};
  const review = await vault.reviewTransferDraft(draft,endpoint);
  const ticket = await vault.reserveTransferDraft(draft,endpoint,review);

  let execution;
  const fetchRpc = globalThis.fetch;
  t.mock.method(globalThis,'fetch',(url,options)=>{
    const {method,params} = JSON.parse(options.body);
    assert.ok(['web3_clientVersion','eth_chainId','eth_getBlockByNumber','eth_getBalance','eth_getCode','eth_call'].includes(method));
    if (method==='eth_call' && params[0].data.length>10) execution = structuredClone(params);
    return fetchRpc(url,options);
  });
  const result = await vault.simulateReservedTransfer(ticket);
  assert.equal(result.digest,draft.digest);assert.ok(execution);
  assert.equal((await decryptPayload(saved,key)).journal[0].simulationAttempt,true);
  assert.deepEqual(await readAccount({endpoint,account,chainId}),state);
  assert.equal(await rpc('eth_getBalance',[recipient,'latest']),'0x0');
  const original = execution[0].data;
  execution[0].data=original.slice(0,-1)+(original.endsWith('0')?'1':'0');
  await assert.rejects(rpc('eth_call',execution),/eth_call/);
  await assert.rejects(vault.simulateReservedTransfer(ticket),{code:'SIGN_RESERVATION'});
});
