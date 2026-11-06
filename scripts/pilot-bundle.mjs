import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {link,mkdir,open,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {keccak256} from '../ui/lib/keccak.js';
import {EvmTreeKey,chainSlot,encodeExecute,encodeRekey,execHasher,grind,leftWord,rekeyHasher,rootFromProof} from '../ui/lib/evmwots.js';
import {TestSigningSession,testIdentitySeeds,testActiveSeeds} from '../ui/test-wallet-core.js';
import {pinnedRuntime} from './local-wallet-chain.mjs';

export const stages = ['create','activate','fund','transfer'];
const gasLimits = [1600000n,650000n,35000n,650000n];
const maxGasPrice = 5000000000n;
const hex = bytes=>'0x'+Buffer.from(bytes).toString('hex');
const wordHex = bytes=>hex(leftWord(bytes)).slice(2);
const asBytes = (value,size)=>{
  assert.equal(typeof value,'string');
  assert.match(value,new RegExp('^0x[0-9a-f]{'+(size*2)+'}$'));
  return Buffer.from(value.slice(2),'hex');
};
const hashRaw = raw=>hex(keccak256(Buffer.from(raw.slice(2),'hex')));
export function cast(args) {
  try {return execFileSync('cast',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:20000,windowsHide:true}).trim();}
  catch {throw new Error('Foundry cast failed. Check the version and dedicated keystore settings.');}
}
function contractAddress(payer) {
  return hex(keccak256(Buffer.from('d694'+payer.slice(2)+'80','hex')).slice(12)); // CREATE with payer nonce zero.
}
async function creationCode() {
  await pinnedRuntime();
  const artifact = JSON.parse(await readFile(new URL('../out/BscTestAccount.sol/BscTestAccount.json',import.meta.url)));
  return artifact.bytecode.object;
}
function message(bundle,stage,rnd) {
  const {payer,account,active,deadline}=bundle;
  if (stage==='activate') {
    const leaf=chainSlot(97), seed=asBytes(active.seed,16), root=asBytes(active.root,16);
    return {leaf, hasher:rekeyHasher(rnd,97,account,0,leaf,deadline,seed,root),
      encode:(salt,proof)=>encodeRekey(seed,root,leaf,deadline,salt,rnd,proof)};
  }
  const calls=[{to:payer,value:1n,data:new Uint8Array()}];
  return {leaf:0,hasher:execHasher(rnd,97,account,1,0,deadline,calls),
    encode:(salt,proof)=>encodeExecute(calls,0,deadline,salt,rnd,proof)};
}

// Publish a complete, flushed file without replacing a concurrent winner.
async function publish(dir,name,value) {
  const tmp=join(dir,randomUUID()+'.tmp');
  const file=await open(tmp,'wx',0o600);
  try {
    try {await file.writeFile(JSON.stringify(value)+'\n');await file.sync();}
    finally {await file.close();}
    await link(tmp,join(dir,name));
    if (process.platform!=='win32') {
      const directory=await open(dir,'r');
      try {await directory.sync();} finally {await directory.close();}
    }
  } finally {await unlink(tmp);}
}

async function transactionInputs(bundle) {
  const create=(await creationCode())+wordHex(asBytes(bundle.identity.seed,16))+wordHex(asBytes(bundle.identity.root,16));
  function authorization(stage,tree) {
    const auth=bundle[stage], rnd=asBytes(auth.randomizer,16), proof=asBytes(auth.proof,448);
    assert.ok(Number.isInteger(auth.salt) && auth.salt>=0 && auth.salt<=0xffffffff);
    const msg=message(bundle,stage,rnd), digest=msg.hasher(auth.salt);
    assert.equal(hex(digest),auth.digest);
    assert.equal(hex(rootFromProof(asBytes(tree.seed,16),msg.leaf,digest,proof)),tree.root,'Invalid saved account proof');
    return hex(msg.encode(auth.salt,proof));
  }
  return [create,authorization('activate',bundle.identity),'0x',authorization('transfer',bundle.active)];
}

export async function validateBundle(bundle,payer) {
  assert.equal(bundle.format,'aurven-testnet-pilot-v1');
  assert.equal(bundle.chainId,97);
  assert.match(payer,/^0x[0-9a-f]{40}$/);assert.equal(bundle.payer,payer);
  assert.equal(bundle.account,contractAddress(payer));
  asBytes(bundle.genesis,32);
  assert.ok(Number.isSafeInteger(bundle.deadline) && bundle.deadline>0);
  assert.match(bundle.gasPrice,/^[1-9][0-9]{0,10}$/);assert.ok(BigInt(bundle.gasPrice)<=maxGasPrice);
  const inputs=await transactionInputs(bundle);
  assert.equal(bundle.transactions.length,stages.length);
  for (const [index,tx] of bundle.transactions.entries()) {
    assert.match(tx.raw,/^0x(?:[0-9a-f]{2}){1,15000}$/);
    assert.equal(hashRaw(tx.raw),tx.hash);
    const result=JSON.parse(cast(['decode-transaction','--json',tx.raw]));
    const decoded=typeof result.data==='string'?JSON.parse(result.data):result.data;
    assert.equal(decoded.signer.toLowerCase(),payer);assert.equal(decoded.chainId,'0x61');
    assert.equal(decoded.type,'0x0');assert.equal(BigInt(decoded.nonce),BigInt(index));
    assert.equal(BigInt(decoded.gasPrice),BigInt(bundle.gasPrice));assert.equal(BigInt(decoded.gas),gasLimits[index]);
    assert.equal(decoded.to?.toLowerCase()??null,index===0?null:bundle.account);
    assert.equal(BigInt(decoded.value),index===2?1n:0n);assert.equal(decoded.input,inputs[index]);
  }
}

export async function prepareBundle({rpc,dir,payer,keystore,passwordFile}) {
  assert.match(payer,/^0x[0-9a-f]{40}$/);
  assert.equal(await rpc('eth_chainId'),'0x61','BSC testnet chain 97 required');
  let saved;
  try {saved=await readFile(join(dir,'signed.json'),'utf8');}
  catch (error) {if (error.code!=='ENOENT') throw error;}
  if (saved!==undefined) {
    const existing=JSON.parse(saved);
    await validateBundle(existing,payer);return existing;
  }
  const genesis=(await rpc('eth_getBlockByNumber',['0x0',false])).hash;
  const gasPrice=BigInt(await rpc('eth_gasPrice'));
  assert.ok(gasPrice>0n && gasPrice<=maxGasPrice,'Testnet gas price outside pilot limits');
  const budget=gasPrice*gasLimits.reduce((sum,n)=>sum+n,0n)+1n;
  assert.ok(BigInt(await rpc('eth_getBalance',[payer,'latest']))>=budget,
    'Faucet tBNB required. Maximum transaction budget at this gas price (wei): '+budget);
  const account=contractAddress(payer);
  assert.equal(await rpc('eth_getTransactionCount',[payer,'pending']),'0x0','Use a fresh dedicated test payer');
  assert.equal(await rpc('eth_getCode',[payer,'latest']),'0x');
  assert.equal(await rpc('eth_getCode',[account,'latest']),'0x');
  assert.equal(await rpc('eth_getBalance',[account,'latest']),'0x0');
  const signerArgs=['--keystore',keystore,'--password-file',passwordFile];
  assert.equal(cast(['wallet','address',...signerArgs]).toLowerCase(),payer,'Keystore address mismatch');
  await mkdir(dir,{recursive:true,mode:0o700});
  const master=randomBytes(32);
  const tree=seeds=>EvmTreeKey.generate(seeds.skSeed,seeds.pubSeed);
  const identity=tree(testIdentitySeeds(master,97,randomBytes(16)));
  let active;
  try {
    active=tree(testActiveSeeds(master,97,account,1,randomBytes(16)));
    const head=await rpc('eth_getBlockByNumber',['latest',false]);
    const now=Number(BigInt(head.timestamp));
    assert.ok(Math.abs(Date.now()/1000-now)<120,'Stale chain head');
    const publicTree=key=>({seed:hex(key.pubSeed),root:hex(key.root)});
    const bundle={format:'aurven-testnet-pilot-v1',chainId:97,genesis,payer,account,gasPrice:gasPrice.toString(),
      deadline:now+1800,identity:publicTree(identity),active:publicTree(active),transactions:[]};
    const session=new TestSigningSession(row=>publish(dir,'spent-'+row.pubSeed+'-'+row.root+'-'+row.leaf+'.json',row));
    for (const [stage,key] of [['activate',identity],['transfer',active]]) {
      const rnd=randomBytes(16), msg=message(bundle,stage,rnd), best=grind(msg.hasher,4096);
      const proof=await session.sign(key,msg.leaf,best.digest);
      bundle[stage]={randomizer:hex(rnd),salt:best.salt,digest:hex(best.digest),proof:hex(proof)};
    }
    const inputs=await transactionInputs(bundle);
    for (const [index,input] of inputs.entries()) {
      // Fully specified fields make cast sign offline. No public RPC receives a proof during preparation.
      const args=['mktx','--chain','97','--rpc-url','http://127.0.0.1:1','--legacy','--gas-limit',String(gasLimits[index]),
        '--gas-price',String(gasPrice),'--nonce',String(index),'--value',index===2?'1':'0',...signerArgs];
      const raw=cast(args.concat(index===0?['--create',input]:[account,input]));
      bundle.transactions.push({raw,hash:hashRaw(raw)});
    }
    await validateBundle(bundle,payer);
    await publish(dir,'signed.json',bundle);
    return bundle;
  } finally {master.fill(0);identity.skSeed.fill(0);active?.skSeed.fill(0);}
}
