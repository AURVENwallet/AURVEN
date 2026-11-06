import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {startLocalNode,pinnedRuntime} from '../scripts/local-wallet-chain.mjs';
import {accountRpc} from '../ui/account-state.js';
import {EXEC_LIMIT,PROOF_LEN,rootFromProof} from '../ui/lib/evmwots.js';
import {fromHex} from '../ui/local-proof.js';
import {checkSource,makeOffer,offerFingerprint,confirmLocalHandover,verifyRotationInput,
  readHandoverState,rotationCalldata,rotationMessage,sendLocalRotation} from '../ui/local-handover.js';
import {hex} from '../ui/vault-crypto.js';

const address='0x'+'45'.repeat(20), seed='0x'+'34'.repeat(16), root='0x'+'56'.repeat(16);
const state={account:address,chainId:31337,epoch:1,next:0,pubSeed:seed,root,timestamp:Math.floor(Date.now()/1000)};
const targetSeed='0x'+'78'.repeat(16),targetRoot='0x'+'ab'.repeat(16);
const error=code=>e=>e.code===code;
test('handover requests bind both trees, account, epoch, chain and expiry to an order-independent fingerprint',()=>{
  const offer=makeOffer(state,targetSeed,targetRoot);
  const original=offerFingerprint(offer);
  assert.equal(original.length,32);
  assert.equal(offerFingerprint(Object.fromEntries(Object.entries(offer).reverse())),original);
  for(const field of ['oldSeed','oldRoot','newSeed','newRoot','deadline','account']){
    const changed=field==='deadline'?offer.deadline-1:field==='account'?'0x'+'cd'.repeat(20):'0x'+'cd'.repeat(16);
    assert.notEqual(offerFingerprint({...offer,[field]:changed}),original);
  }
  for(const changes of [{chainId:97},{chainId:56},{newRoot:root},{newSeed:seed},{oldRoot:'0x'+'00'.repeat(16)},
    {epoch:2},{extra:true},{deadline:0},{account:[address]}]){
    assert.throws(()=>offerFingerprint({...offer,...changes}),error('HANDOVER_OFFER'));
  }
  for(const change of [{epoch:2},{chainId:97},{root:targetRoot},{pubSeed:targetSeed},
    {account:'0x'+'11'.repeat(20)},{next:EXEC_LIMIT+1},{timestamp:offer.deadline},{timestamp:state.timestamp-2}]){
    assert.throws(()=>checkSource(offer,{...state,...change}),error('HANDOVER_STALE'));
  }
  checkSource(offer,state);
});
test('handover never connects to a supplied public RPC or a non-Anvil chain',async t=>{
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>assert.fail('unexpected network access'));
  for(const rpc of ['https://bsc-testnet.bnbchain.org','https://example.org/','http://127.0.0.1:443/path',
    'http://127.0.0.1.example.org/','http://attacker@127.0.0.1/']){
    await assert.rejects(readHandoverState(rpc,address),error('SIGN_LOCAL'));
  }
  assert.equal(fetchMock.mock.callCount(),0);
  fetchMock.mock.mockImplementation(async(_url,options)=>{
    const {id,method}=JSON.parse(options.body);
    return Response.json({jsonrpc:'2.0',id,result:method==='eth_chainId'?'0x7a69':'another-client'});
  });
  await assert.rejects(readHandoverState('http://127.0.0.1:1234/',address),error('SIGN_LOCAL'));
});
test('a receiver independently verifies canonical calldata, the retired-key proof and current root after a later local block',async t=>{
  const node=await startLocalNode();t.after(()=>node.close());
  const rpc=accountRpc(node.endpoint);
  const fixture=await node.setupAccount(await pinnedRuntime());
  const before=await readHandoverState(node.endpoint,fixture.account);
  // Build a one-use synthetic source root around a fixture proof, then pin it on the disposable chain.
  const offer=makeOffer({...before,root},targetSeed,targetRoot);
  const message=rotationMessage(offer),proof=randomBytes(PROOF_LEN);
  offer.oldRoot='0x'+hex(rootFromProof(fromHex(before.pubSeed.slice(2)),EXEC_LIMIT,fromHex(message.digest),proof));
  await fixture.pair(offer.oldRoot);
  const data=rotationCalldata(offer,message,proof);
  verifyRotationInput(offer,data);
  for(const value of [data.slice(2),data+'00',data.replace(/^0x./,v=>v==='0x0'?'0x1':'0x0'),
    data.slice(0,-2)+(data.endsWith('12')?'34':'12')]){
    assert.throws(()=>verifyRotationInput(offer,value),error('HANDOVER_PROOF'));
  }
  const mark=await rpc('evm_snapshot');
  await assert.rejects(confirmLocalHandover(node.endpoint,offer),error('HANDOVER_PENDING'));
  let checks=0;
  const hash=await sendLocalRotation(node.endpoint,offer,data,()=>{checks++;});
  assert.equal(checks,2);
  await assert.rejects(confirmLocalHandover(node.endpoint,offer),error('HANDOVER_PENDING'));
  await rpc('evm_mine');
  assert.equal((await confirmLocalHandover(node.endpoint,offer)).hash,hash);
  await assert.rejects(confirmLocalHandover(node.endpoint,{...offer,deadline:offer.deadline-1}),error('HANDOVER_PROOF'));
  await assert.rejects(sendLocalRotation(node.endpoint,offer,data,()=>{}),error('HANDOVER_STALE'));
  await rpc('evm_revert',[mark]);
  await assert.rejects(confirmLocalHandover(node.endpoint,offer),error('HANDOVER_PENDING'));
});
