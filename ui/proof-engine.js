import {decryptPayload,hex,fail} from './vault-crypto.js';
import {EvmTreeKey} from './lib/evmwots.js';
import {fromHex,verificationSeeds,validateProofContext,proofDigest,verifyLocalProof} from './local-proof.js';

// This engine lives in a disposable worker. No seed or signing key is returned.
export class ProofEngine {
  #tree;#identity;#used=new Set();#busy=false;
  constructor(generate=EvmTreeKey.generate){this.generate=generate;}
  dispose(){this.#tree?.skSeed.fill(0);this.#tree=undefined;this.#identity=undefined;this.#used.clear();}
  async build(record,key,progress){
    if(this.#busy||this.#tree)fail('BUSY');this.#busy=true;
    let master,skSeed;
    try{
      const payload=await decryptPayload(record,key);
      if(record.mode!=='active')fail('RECOVERY');
      master=fromHex(payload.seed);
      const seeds=verificationSeeds(master,record.chainId,record.walletId);skSeed=seeds.skSeed;
      this.#tree=this.generate(skSeed,seeds.pubSeed,progress);
      this.#identity={walletId:record.walletId,chainId:record.chainId,pubSeed:hex(this.#tree.pubSeed),root:hex(this.#tree.root)};
      return {...this.#identity};
    }catch(error){skSeed?.fill(0);this.dispose();throw error;}
    finally{master?.fill(0);this.#busy=false;}
  }
  sign(context){
    if(!this.#tree||this.#busy)fail('TREE_REQUIRED');
    validateProofContext(context);
    for(const field of ['walletId','chainId','pubSeed','root'])if(context[field]!==this.#identity[field])fail('PROOF_CONTEXT');
    if(this.#used.has(context.leaf))fail('USED');
    this.#used.add(context.leaf);
    const digest=proofDigest(context),proof=this.#tree.sign(context.leaf,digest);
    const result={...context,digest:hex(digest),proof:hex(proof)};
    if(!verifyLocalProof(result))fail('PROOF_VERIFY');
    return result;
  }
}
