import {EvmTreeKey,grind,chainSlot,execHasher,rekeyHasher,addressWord,word,leftWord,dynBytes,concat} from './lib/evmwots.js';
import {TestSigningSession,hex,testIdentitySeeds,testActiveSeeds} from './test-wallet-core.js';
import {createdAddress,hashBytes,requireTrial} from './browser-trial.js';
import {trialInitHash} from './contract-pin.js';

const random=size=>crypto.getRandomValues(new Uint8Array(size));
export async function buildTrialData(plan,bytecode,reserve,progress=()=>{}) {
  requireTrial(hashBytes(bytecode)===trialInitHash,'TRIAL_DATA');
  requireTrial(plan.wrapper===createdAddress(plan.payer,plan.nonce) && plan.account===createdAddress(plan.wrapper,1),'TRIAL_NONCE');
  const master=random(32), identity=testIdentitySeeds(master,97,random(16)), active=testActiveSeeds(master,97,plan.account,1,random(16));
  try {
    const identityTree=EvmTreeKey.generate(identity.skSeed,identity.pubSeed,p=>progress(p*0.48));
    const activeTree=EvmTreeKey.generate(active.skSeed,active.pubSeed,p=>progress(0.48+p*0.48));
    const sign=new TestSigningSession(reserve);
    const bootRnd=random(16),execRnd=random(16),leaf=chainSlot(97);
    const boot=grind(rekeyHasher(bootRnd,97,plan.account,0,leaf,plan.deadline,active.pubSeed,activeTree.root),4096);
    const bootProof=await sign.sign(identityTree,leaf,boot.digest);
    const calls=[{to:plan.recipient,value:1n,data:new Uint8Array()}];
    const transfer=grind(execHasher(execRnd,97,plan.account,1,0,plan.deadline,calls),4096);
    const transferProof=await sign.sign(activeTree,0,transfer.digest);
    const bootTail=dynBytes(bootProof),headSize=13*32;
    const args=concat(addressWord(plan.account),addressWord(plan.recipient),word(plan.deadline),
      leftWord(identity.pubSeed),leftWord(identityTree.root),leftWord(active.pubSeed),leftWord(activeTree.root),
      word(boot.salt),leftWord(bootRnd),word(headSize),word(transfer.salt),leftWord(execRnd),word(headSize+bootTail.length),
      bootTail,dynBytes(transferProof));
    return {data:bytecode+hex(args),digest:'0x'+hex(transfer.digest)};
  } finally {master.fill(0);identity.skSeed.fill(0);active.skSeed.fill(0);}
}
