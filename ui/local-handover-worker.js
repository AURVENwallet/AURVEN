import {decryptPayload,fail,hex} from './vault-crypto.js';
import {EvmTreeKey,EXEC_LIMIT} from './lib/evmwots.js';
import {testActiveSeeds} from './test-wallet-core.js';
import {fromHex} from './local-proof.js';
import {makeOffer,validateOffer,rotationCalldata,rotationHasher} from './local-handover.js';

self.onmessage=async({data:{id,type,payload}})=>{
  self.onmessage=null;
  let master;
  try {
    const {record,key,state,offer,message}=payload;
    if (record.chainId!==31337 || record.mode!=='active') fail('RECOVERY');
    const plain=await decryptPayload(record,key);
    master=fromHex(plain.seed);
    function tree(account,epoch,seed) {
      const seeds=testActiveSeeds(master,31337,account,epoch,fromHex(seed.slice(2)));
      return EvmTreeKey.generate(seeds.skSeed,seeds.pubSeed);
    }
    if (type==='offer') {
      if (state.chainId!==31337 || state.epoch!==1 || plain.journal.length) fail('HANDOVER_FRESH');
      const old=tree(state.account,1,state.pubSeed);
      old.skSeed.fill(0);
      if ('0x'+hex(old.root)===state.root) fail('HANDOVER_FRESH');
      const seed='0x'+hex(crypto.getRandomValues(new Uint8Array(16))),next=tree(state.account,2,seed);
      next.skSeed.fill(0);
      self.postMessage({id,result:makeOffer(state,seed,'0x'+hex(next.root))});
    } else if (type==='rotate') {
      validateOffer(offer);
      const row=plain.journal.find(r=>r.pubSeed===offer.oldSeed.slice(2)&&r.root===offer.oldRoot.slice(2)&&r.leaf===EXEC_LIMIT);
      if (!row || row.account!==offer.account || row.epoch!==1 || row.digest!==message.digest) fail('HANDOVER_PROOF');
      const old=tree(offer.account,1,offer.oldSeed);
      try {
        if ('0x'+hex(old.root)!==offer.oldRoot) fail('NET_KEYS');
        // Recompute and validate the reserved digest before using this one-time key.
        const digest=rotationHasher(offer,fromHex(message.rnd))(message.salt);
        if (hex(digest)!==row.digest) fail('HANDOVER_PROOF');
        self.postMessage({id,result:rotationCalldata(offer,message,old.sign(EXEC_LIMIT,digest))});
      } finally {old.skSeed.fill(0);}
    } else fail('HANDOVER_OFFER');
  } catch(error){self.postMessage({id,error:error.code??'WORKER'});}
  finally{master?.fill(0);self.close();}
};
