import {decryptPayload,fail,hex} from './vault-crypto.js';
import {testActiveSeeds,testIdentitySeeds} from './test-wallet-core.js';
import {EvmTreeKey,grind} from './lib/evmwots.js';
import {fromHex} from './local-proof.js';
import {reservedHandoverIntent} from './handover-payment.js';
import {networkHasher,setup,validateNetworkPlan} from './vault-network-proof.js';

const random=n=>crypto.getRandomValues(new Uint8Array(n));
let prepared;
self.onmessage=async({data:{id,type,payload}})=>{
  try {
    if (type==='sign' && prepared && payload.digest===prepared.intent.digest) {
      const {tree,intent}=prepared;prepared=undefined;
      const result=tree.sign(intent.leaf,fromHex(intent.digest));
      tree.skSeed.fill(0);self.postMessage({id,result},[result.buffer]);self.close();return;
    }
    if (!['prepare','repair'].includes(type) || prepared) fail('NET_PROOF');
    const {record,key,plan,leaf}=payload;
    validateNetworkPlan(plan);
    if (record.mode!=='active' || record.chainId!==97 || record.walletId!==plan.walletId) fail('RECOVERY');
    const payloadData=await decryptPayload(record,key);
    const committed=type==='repair'?reservedHandoverIntent(plan,payloadData.journal):null;
    const master=fromHex(payloadData.seed);
    let source,successor;
    try {
      const buildingTwo=plan.kind!=='send' && !plan.offer, startup=setup(plan.kind);
      const build=(seeds,second)=>EvmTreeKey.generate(seeds.skSeed,seeds.pubSeed,p=>
        self.postMessage({id,progress:buildingTwo?(second?0.5:0)+p/2:p}));
      // The bootstrap key exists only in this worker. Subsequent trees belong to the encrypted vault.
      if (startup) {
        const transient=random(32);
        try {source=testIdentitySeeds(transient,97,random(16));} finally {transient.fill(0);}
      } else source=testActiveSeeds(master,97,plan.account,plan.snapshot.epoch,fromHex(plan.snapshot.pubSeed.slice(2)));
      const tree=build(source,false);
      if (!startup && '0x'+hex(tree.root)!==plan.snapshot.root) fail('NET_KEYS');
      if(committed){
        const proof=tree.sign(committed.leaf,fromHex(committed.digest));
        self.postMessage({id,result:proof},[proof.buffer]);self.close();return;
      }
      const intent={leaf,seed:hex(tree.pubSeed),root:hex(tree.root),rnd:hex(random(16))};
      if(plan.offer){intent.newSeed=plan.offer.newSeed.slice(2);intent.newRoot=plan.offer.newRoot.slice(2);}
      if (buildingTwo) {
        successor=testActiveSeeds(master,97,plan.account,(plan.snapshot?.epoch??0)+1,random(16));
        const next=build(successor,true);intent.newSeed=hex(next.pubSeed);intent.newRoot=hex(next.root);
      }
      const best=grind(networkHasher(plan,intent),4096);intent.digest=hex(best.digest);intent.salt=best.salt;
      prepared={tree,intent};self.postMessage({id,result:intent});
    } finally {master.fill(0);successor?.skSeed.fill(0);if (!prepared) source?.skSeed.fill(0);}
  } catch (e) {self.postMessage({id,error:e.code??'NET_PROOF'});self.close();}
};
