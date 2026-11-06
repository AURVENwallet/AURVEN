import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {accountRpc} from '../ui/account-state.js';
import {createdAddress,hashBytes} from '../ui/browser-trial.js';
import {keccak256} from '../ui/lib/keccak.js';
import {FACTORY_INIT,ACCOUNT_INIT} from '../ui/lib/evmcode.js';
import {EvmTreeKey,LEAVES,EXEC_LIMIT,accountAddress,addressWord,word,leftWord,concat,dynBytes,
  leafPk,encodeExecute,encodeRekey,execHasher,rekeyHasher} from '../ui/lib/evmwots.js';

const endpoints=['https://bsc-dataseed.bnbchain.org','https://bsc-dataseed-public.bnbchain.org'];
const allowed=new Set(['eth_chainId','eth_getBlockByNumber','eth_getTransactionCount','eth_getCode','eth_getBalance','eth_call','eth_estimateGas','eth_gasPrice']);
const hex=b=>'0x'+Buffer.from(b).toString('hex');
const bytes=h=>Buffer.from(h.slice(2),'hex');
const label=s=>keccak256(new TextEncoder().encode('AURVEN public simulation / '+s));
const method='run(address,address,bytes16,bytes16,bytes,bytes,bytes,bytes,bytes,bytes)';
async function artifact(name){
  return JSON.parse(await readFile(new URL('../out/'+name+'.sol/'+name+'.json',import.meta.url)));
}
function fixtureTree(labelPrefix,used){
  // Public repeatable fixtures. Only the leaves exercised by the scenario need valid WOTS chains.
  const sk=label(labelPrefix+'/fixture'),seed=label(labelPrefix+'/seed').slice(0,16);
  const leaves=Array.from({length:LEAVES},(_,i)=>used.includes(i)?leafPk(sk,seed,i):keccak256(seed,word(i)).slice(0,16));
  return new EvmTreeKey(sk,seed,leaves);
}
function scenario(block,factoryInit){
  const tag=block.hash,driver=hex(label(tag+'/driver').slice(12)),recipient=hex(label(tag+'/recipient').slice(12));
  const factory=createdAddress(driver,1);
  const identity=fixtureTree(tag+'/bootstrap',[0]),first=fixtureTree(tag+'/first',[0,1,EXEC_LIMIT]),second=fixtureTree(tag+'/second',[0]);
  const account=accountAddress(identity.pubSeed,identity.root,factory);
  const deadline=BigInt(block.timestamp)+600n,rnd=label(tag+'/rnd').slice(0,16);
  const calls=[{to:recipient,value:1n,data:new Uint8Array()}];
  function rekey(signer,epoch,leaf,next){
    const digest=rekeyHasher(rnd,56,account,epoch,leaf,deadline,next.pubSeed,next.root)(0);
    return encodeRekey(next.pubSeed,next.root,leaf,deadline,0,rnd,signer.sign(leaf,digest));
  }
  function transfer(signer,chain,epoch,leaf){
    const digest=execHasher(rnd,chain,account,epoch,leaf,deadline,calls)(0);
    return encodeExecute(calls,leaf,deadline,0,rnd,signer.sign(leaf,digest));
  }
  const bodies=[rekey(identity,0,0,first),transfer(first,56,1,0),rekey(first,1,EXEC_LIMIT,second),
    transfer(second,56,2,0),transfer(first,97,1,1),bytes(factoryInit)].map(dynBytes);
  let offset=(4+bodies.length)*32;
  const offsets=bodies.map(body=>{const start=word(offset);offset+=body.length;return start;});
  const selector=keccak256(new TextEncoder().encode(method)).slice(0,4);
  return {driver,factory,account,recipient,data:hex(concat(selector,addressWord(account),addressWord(recipient),
    leftWord(identity.pubSeed),leftWord(identity.root),...offsets,...bodies))};
}
async function empty(rpc,addresses,at){
  await Promise.all(addresses.map(async address=>{
    const [code,nonce,balance]=await Promise.all([rpc('eth_getCode',[address,at]),rpc('eth_getTransactionCount',[address,at]),rpc('eth_getBalance',[address,at])]);
    assert.deepEqual([code,nonce,balance],['0x','0x0','0x0'],'Fixture address is already in use');
  }));
}

export async function rehearseMainnet(nodes=endpoints.map(url=>accountRpc(url))){
  assert.equal(nodes.length,2,'Two RPC observations required');
  const clients=nodes.map(rpc=>(name,params=[])=>{assert.ok(allowed.has(name),'Read-only rehearsal');return rpc(name,params);});
  const [[factory,account,driver],heads]=await Promise.all([
    Promise.all(['KeyLabFactory','KeyLabAccount','MainnetScenario'].map(artifact)),
    Promise.all(clients.map(async rpc=>{
      assert.equal(await rpc('eth_chainId'),'0x38','BSC mainnet chain 56 required');
      return rpc('eth_getBlockByNumber',['finalized',false]);
    }))
  ]);
  for(const h of heads)assert.ok(h && /^0x[0-9a-f]+$/.test(h.number) && /^0x[0-9a-f]{64}$/.test(h.hash),'Missing finalized head');
  const block=BigInt(heads[0].number)<=BigInt(heads[1].number)?heads[0]:heads[1],at=block.number;
  assert.ok(heads.every(h=>/^0x[0-9a-f]+$/.test(h.timestamp) && Math.abs(Date.now()/1000-Number(BigInt(h.timestamp)))<=120),
    'Expected recent finalized heads');
  assert.ok(heads.every(h=>h.number!==at || h.hash===block.hash),'Finalized heads disagree');
  const confirm=async rpc=>{
    const b=await rpc('eth_getBlockByNumber',[at,false]);
    assert.ok(b?.number===at && b.hash===block.hash && b.timestamp===block.timestamp,'Finalized block mismatch');
  };
  await Promise.all(clients.map(confirm));
  assert.equal(factory.bytecode.object,'0x'+FACTORY_INIT,'Compiled factory differs from the client pin');
  assert.equal(account.bytecode.object,'0x'+ACCOUNT_INIT,'Compiled account differs from the client pin');
  const fixture=scenario(block,factory.bytecode.object);
  const expected=[factory,account].map(a=>hashBytes(a.deployedBytecode.object));
  const result=await Promise.all(clients.map(async rpc=>{
    const addresses=[fixture.driver,fixture.factory,fixture.account,fixture.recipient];await empty(rpc,addresses,at);
    const creation={data:factory.bytecode.object};
    const estimate=await rpc('eth_estimateGas',[creation,at]);
    assert.ok(BigInt(estimate)>21000n);
    assert.equal(await rpc('eth_call',[{...creation,gas:estimate},at]),factory.deployedBytecode.object);
    const overrides={[fixture.driver]:{code:driver.deployedBytecode.object,nonce:'0x1',balance:'0x3'}};
    const data=await rpc('eth_call',[{to:fixture.driver,data:fixture.data,gas:'0xe4e1c0'},at,overrides]);
    assert.equal(data,hex(concat(...expected.map(bytes),word(2),word(1),word(1))),'Unexpected final state or runtime');
    await empty(rpc,addresses,at);
    await confirm(rpc);
    assert.equal(await rpc('eth_chainId'),'0x38');
    const finalized=await rpc('eth_getBlockByNumber',['finalized',false]);
    assert.ok(BigInt(finalized.number)>=BigInt(at) && (finalized.number!==at || finalized.hash===block.hash),'Finality changed');
    return {factoryGas:BigInt(estimate).toString(),gasPriceWei:BigInt(await rpc('eth_gasPrice')).toString()};
  }));
  assert.equal(result[0].factoryGas,result[1].factoryGas,'Factory estimates differ');
  return {simulationOnly:true,chainId:56,block:at,hash:block.hash,blockTime:new Date(Number(BigInt(block.timestamp))*1000).toISOString(),
    factoryRuntimeHash:expected[0],accountRuntimeHash:expected[1],factoryGas:result[0].factoryGas,
    gasPriceWei:result.map(r=>r.gasPriceWei),finalEpoch:2,nextLeaf:1,fixtureBalanceWei:'1',realFeeWei:'0'};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  console.log(JSON.stringify(await rehearseMainnet(),null,2));
}
