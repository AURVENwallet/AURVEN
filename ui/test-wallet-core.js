// Experimental test-wallet derivation. This is not an encrypted wallet store.
import {sha256} from './lib/sha256.js';
import {word,chainTreeSeeds,rootFromProof,PROOF_LEN,LEAVES} from './lib/evmwots.js';
const enc=new TextEncoder();
export const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
function bytes(value,length,name){
  if(!(value instanceof Uint8Array)||value.length!==length)throw new Error(name+' 长度无效');
}
export function requireTestChain(chainId){
  if(![97,31337].includes(chainId))throw new Error('仅允许测试网络 97 / 31337');
}
export function testIdentitySeeds(master,chainId,walletId){
  requireTestChain(chainId);bytes(master,32,'测试种子');bytes(walletId,16,'钱包标识');
  return {
    skSeed:sha256(enc.encode('aurven/test-wallet/identity/sk/v1'),master,word(chainId),walletId),
    pubSeed:sha256(enc.encode('aurven/test-wallet/identity/pub/v1'),master,word(chainId),walletId).slice(0,16)
  };
}
export function testActiveSeeds(master,chainId,account,epoch,pubSeed){
  requireTestChain(chainId);bytes(master,32,'测试种子');
  return chainTreeSeeds(master,chainId,account,epoch,pubSeed);
}

// Single process protection for disposable local demonstrations only. Reservation
// MUST complete before releasing a proof. Production multi-device recovery is separate.
export class TestSigningSession {
  #used=new Set();
  constructor(reserve){
    if(typeof reserve!=='function')throw new Error('签名前必须提供持久化预留步骤');
    this.reserve=reserve;
  }
  async sign(tree,leaf,digest){
    if(!Number.isInteger(leaf)||leaf<0||leaf>=LEAVES)throw new Error('叶号无效');
    bytes(digest,16,'摘要');bytes(tree.pubSeed,16,'公开种子');bytes(tree.root,16,'根');
    const key=hex(tree.pubSeed)+':'+hex(tree.root)+':'+leaf;
    if(this.#used.has(key))throw new Error('该叶已预留，禁止再次签名');
    this.#used.add(key); // Fail closed, including concurrent calls and storage errors.
    await this.reserve({pubSeed:hex(tree.pubSeed),root:hex(tree.root),leaf,digest:hex(digest)});
    const proof=tree.sign(leaf,digest);
    if(proof.length!==PROOF_LEN||hex(rootFromProof(tree.pubSeed,leaf,digest,proof))!==hex(tree.root)){
      throw new Error('签名自检失败；该叶仍保持已消耗状态');
    }
    return proof;
  }
}
