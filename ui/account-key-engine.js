import {decryptPayload,hex,fail} from './vault-crypto.js';
import {EvmTreeKey} from './lib/evmwots.js';
import {testIdentitySeeds,testActiveSeeds} from './test-wallet-core.js';
import {fromHex} from './local-proof.js';
import {validateKeySnapshot} from './account-key-check.js';

// A single-use root calculation. There is deliberately no signing operation.
export async function deriveAccountRoot({record,key,snapshot},progress,generate=EvmTreeKey.generate){
  let master,skSeed,tree;
  try{
    const payload=await decryptPayload(record,key);
    const state=validateKeySnapshot(snapshot,record.chainId,snapshot.account);
    master=fromHex(payload.seed);
    const seeds=state.epoch===0?testIdentitySeeds(master,state.chainId,fromHex(record.walletId)):
      testActiveSeeds(master,state.chainId,state.account,state.epoch,fromHex(state.pubSeed.slice(2)));
    skSeed=seeds.skSeed;tree=generate(skSeed,seeds.pubSeed,progress);
    if(!tree||tree.root?.length!==16||tree.pubSeed?.length!==16)fail('KEY_CONTEXT');
    return {walletId:record.walletId,chainId:state.chainId,account:state.account,epoch:state.epoch,
      pubSeed:'0x'+hex(tree.pubSeed),root:'0x'+hex(tree.root)};
  }finally{master?.fill(0);skSeed?.fill(0);tree?.skSeed?.fill(0);}
}
