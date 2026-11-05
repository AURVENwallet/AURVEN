// Verification-only messages use a separate key derivation and digest domain.
// These proofs are not transaction approvals or evidence of account ownership.
import {sha256} from './lib/sha256.js';
import {word,rootFromProof,PROOF_LEN,LEAVES} from './lib/evmwots.js';
import {hex,fail} from './vault-crypto.js';
export const LOCAL_PROOF_FORMAT='aurven-local-proof-v1';
export const PROOF_ACCOUNT='0x'+'00'.repeat(20);
const enc=new TextEncoder();
const fields=['format','purpose','walletId','chainId','pubSeed','root','leaf','message','challenge'];
const isHex=(s,n)=>typeof s==='string'&&s.length===n&&/^[0-9a-f]+$/.test(s);
export const fromHex=s=>Uint8Array.from(s.match(/../g),v=>parseInt(v,16));
export function validateProofMessage(message){
  if(typeof message!=='string'||message.length>560||[...message].length>280||!message.trim()||enc.encode(message).length>1120)fail('MESSAGE');
  return message;
}
export function validateProofContext(value,signed=false){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==
    [...fields,...(signed?['digest','proof']:[])].sort().join('|'))fail('PROOF_FORMAT');
  if(value.format!==LOCAL_PROOF_FORMAT||value.purpose!=='verification-only'||![97,31337].includes(value.chainId)||
    !isHex(value.walletId,32)||!isHex(value.pubSeed,32)||!isHex(value.root,32)||!isHex(value.challenge,32)||
    !Number.isInteger(value.leaf)||value.leaf<0||value.leaf>=LEAVES)fail('PROOF_FORMAT');
  validateProofMessage(value.message);
  if(signed&&(!isHex(value.digest,32)||!isHex(value.proof,PROOF_LEN*2)))fail('PROOF_FORMAT');
  return value;
}
export function proofDigest(context){
  validateProofContext(context);
  return sha256(enc.encode('aurven/local-proof/message/v1'),word(context.chainId),fromHex(context.walletId),
    fromHex(context.pubSeed),fromHex(context.root),word(context.leaf),fromHex(context.challenge),enc.encode(context.message)).slice(0,16);
}
export function verificationSeeds(master,chainId,walletId){
  if(!(master instanceof Uint8Array)||master.length!==32||![97,31337].includes(chainId)||!isHex(walletId,32))fail('PROOF_FORMAT');
  const suffix=[master,word(chainId),fromHex(walletId)];
  return {skSeed:sha256(enc.encode('aurven/test-wallet/verification/sk/v1'),...suffix),
    pubSeed:sha256(enc.encode('aurven/test-wallet/verification/pub/v1'),...suffix).slice(0,16)};
}
export function verifyLocalProof(report){
  validateProofContext(report,true);
  const {digest,proof,...context}=report,computed=proofDigest(context);
  return hex(computed)===digest&&hex(rootFromProof(fromHex(report.pubSeed),report.leaf,computed,fromHex(proof)))===report.root;
}
export function proofTreeState(journal,tree){
  const rows=journal.filter(row=>row.pubSeed===tree.pubSeed&&row.root===tree.root);
  return {used:rows.length,nextLeaf:rows.reduce((next,row)=>Math.max(next,row.leaf+1),0)};
}
