import {randomBytes} from 'node:crypto';
import {sha256} from '../ui/lib/sha256.js';
import {keccak256} from '../ui/lib/keccak.js';
import {createdAddress} from '../ui/browser-trial.js';
import {EvmTreeKey,accountAddress,addressBytes,addressWord,word,leftWord,concat,dynBytes,
  rekeyHasher,execHasher,encodeExecute} from '../ui/lib/evmwots.js';

const text=new TextEncoder();
const chainId=56;
export const bootstrapLeaf=9;
export const factoryPins=Object.freeze({
  init:'0xb8f0313ec017887e63f0604430c0346c94be80cfdc82ca57cd21156ececef752',
  runtime:'0x5c6acbf647dd904587d5d3511a42aea596a4ef23e9ae85b83e236b62ec356101'
});
const hex=bytes=>'0x'+Buffer.from(bytes).toString('hex');
const domain=name=>text.encode('aurven/bsc-mainnet/'+name+'/v1');

function keyContext(master,factory,walletId){
  if(!(master instanceof Uint8Array) || master.length!==32)throw Error('Expected a 32-byte master seed');
  if(!(walletId instanceof Uint8Array) || walletId.length!==16)throw Error('Expected a 16-byte wallet ID');
  return [master,word(chainId),addressBytes(factory),walletId];
}
export function mainnetIdentitySeeds(master,factory,walletId){
  const context=keyContext(master,factory,walletId);
  return {skSeed:sha256(domain('identity/sk'),...context),pubSeed:sha256(domain('identity/pub'),...context).slice(0,16)};
}
export function mainnetActiveSeeds(master,factory,walletId,account,epoch,pubSeed){
  if(!Number.isInteger(epoch) || epoch<1 || epoch>0xffffffff)throw Error('Invalid active epoch');
  if(!(pubSeed instanceof Uint8Array) || pubSeed.length!==16)throw Error('Expected a 16-byte public seed');
  return {skSeed:sha256(domain('active/sk'),...keyContext(master,factory,walletId),addressBytes(account),word(epoch),pubSeed),
    pubSeed:pubSeed.slice()};
}

const activationSelector=keccak256(text.encode('createAndActivate(address,bytes16,bytes16,bytes16,bytes16,uint64,uint32,bytes16,bytes)')).slice(0,4);
const runSelector=keccak256(text.encode('runSetup(bytes,address,address,bytes16,bytes16,bytes,bytes)')).slice(0,4);

// Fresh, process-local inputs for one read-only fixture. Never load a real wallet or reuse a fixture leaf.
export function prepareSetupFixture(){
  const master=randomBytes(32),walletId=randomBytes(16);
  const driver=hex(randomBytes(20)),factory=createdAddress(driver,1),recipient=hex(randomBytes(20));
  const build=seeds=>EvmTreeKey.generate(seeds.skSeed,seeds.pubSeed);
  const identity=build(mainnetIdentitySeeds(master,factory,walletId));
  const account=accountAddress(identity.pubSeed,identity.root,factory);
  const active=build(mainnetActiveSeeds(master,factory,walletId,account,1,randomBytes(16)));
  master.fill(0);

  let consumed=false;
  return {driver,factory,account,recipient,encode(block,init){
    if(consumed)throw Error('Fixture already consumed');
    consumed=true;
    const deadline=BigInt(block.timestamp)+600n,rnd=randomBytes(16),paymentRnd=randomBytes(16);
    try{
      const digest=rekeyHasher(rnd,chainId,account,0,bootstrapLeaf,deadline,active.pubSeed,active.root)(0);
      const proof=identity.sign(bootstrapLeaf,digest);
      const activation=concat(activationSelector,addressWord(account),leftWord(identity.pubSeed),leftWord(identity.root),
        leftWord(active.pubSeed),leftWord(active.root),word(deadline),word(0),leftWord(rnd),word(9*32),dynBytes(proof));
      const calls=[{to:recipient,value:1n,data:new Uint8Array()}];
      const paymentDigest=execHasher(paymentRnd,chainId,account,1,0,deadline,calls)(0);
      const payment=encodeExecute(calls,0,deadline,0,paymentRnd,active.sign(0,paymentDigest));
      const factoryBody=dynBytes(Buffer.from(init.slice(2),'hex')),activationBody=dynBytes(activation);
      const offset=7*32;
      return {activation:hex(activation),scenario:hex(concat(runSelector,word(offset),addressWord(account),addressWord(recipient),
        leftWord(identity.pubSeed),leftWord(identity.root),word(offset+factoryBody.length),
        word(offset+factoryBody.length+activationBody.length),factoryBody,activationBody,dynBytes(payment)))};
    }finally{identity.skSeed.fill(0);active.skSeed.fill(0);}
  }};
}
