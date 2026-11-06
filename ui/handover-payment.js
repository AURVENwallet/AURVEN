import {hex,fail} from './vault-crypto.js';
import {PROOF_LEN} from './lib/evmwots.js';
import {fromHex} from './local-proof.js';
import {hashBytes} from './browser-trial.js';
import {validateIntent,validateNetworkPlan} from './vault-network-proof.js';
import {verifyRotationCalldata} from './rotation-calldata.js';

const encoder=new TextEncoder();
const encryptedLength=2*(4+8*32+PROOF_LEN+16); // Selector, ABI words, proof and the GCM tag.
// Authenticate the original fee request as well as the WOTS authorization, which only binds the rotation.
function paymentContext(plan,dataHash){
  const s=plan.snapshot;
  return encoder.encode(JSON.stringify(['aurven-testnet-handover-payment-v1',plan.id,plan.walletId,
    plan.kind,plan.chainId,plan.account,plan.payer,plan.recipient,plan.nonce,plan.value,plan.gas,plan.gasPrice,
    plan.startBlock,plan.reviewBlock?.number,plan.reviewBlock?.hash,s.epoch,s.next,s.root,s.pubSeed,s.codeHash,
    s.balanceWei,plan.fingerprint,plan.deadline,dataHash]));
}
// The fee context and digest are committed before the worker may sign. Recovery can only reproduce that digest.
export function handoverBinding(plan){
  return hashBytes('0x'+hex(paymentContext(plan,'reserved-intent-v1')));
}
export function reservedHandoverIntent(plan,journal){
  validateNetworkPlan(plan);
  if(!plan.offer)fail('REPAIR_MISSING');
  const binding=handoverBinding(plan);
  const row=journal.find(r=>r.handoverOut && r.commitment?.binding===binding);
  if(!row)fail('REPAIR_MISSING');
  if(row.chainId!==97 || row.account!==plan.account || row.epoch!==plan.snapshot.epoch)fail('RETRY_INVALID');
  const intent={leaf:row.leaf,seed:row.pubSeed,root:row.root,newSeed:plan.offer.newSeed.slice(2),
    newRoot:plan.offer.newRoot.slice(2),digest:row.digest,salt:row.commitment.salt,rnd:row.commitment.rnd};
  validateIntent(plan,intent,row.leaf);
  return intent;
}
export async function sealHandoverPayment(key,plan,data){
  const iv=crypto.getRandomValues(new Uint8Array(12)),dataHash=hashBytes(data);
  const bytes=fromHex(data.slice(2));
  try{
    const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:paymentContext(plan,dataHash)},key,bytes);
    return {dataHash,escrow:{iv:hex(iv),cipher:hex(new Uint8Array(cipher))}};
  }finally{bytes.fill(0);}
}
export async function openHandoverPayment(key,row,journal){
  if(!row.offer || !row.escrow)fail('RETRY_MISSING');
  if(row.deadline<=Date.now()/1000)fail('TRIAL_CLOCK');
  validateNetworkPlan(row);
  const {escrow,intent}=row;
  if(typeof escrow.iv!=='string' || !/^[0-9a-f]{24}$/.test(escrow.iv) ||
    typeof escrow.cipher!=='string' || escrow.cipher.length!==encryptedLength || !/^[0-9a-f]+$/.test(escrow.cipher) ||
    !/^0x[0-9a-f]{64}$/.test(row.dataHash) || !intent)fail('RETRY_INVALID');
  const reservation=journal.find(r=>r.handoverOut && r.chainId===97 && r.account===row.account &&
    r.epoch===row.snapshot.epoch && r.pubSeed===intent.seed && r.root===intent.root &&
    r.leaf===intent.leaf && r.digest===intent.digest);
  if(!reservation)fail('RETRY_INVALID');
  validateIntent(row,intent,reservation.leaf);
  let bytes;
  try{
    bytes=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:fromHex(escrow.iv),
      additionalData:paymentContext(row,row.dataHash)},key,fromHex(escrow.cipher)));
    const data='0x'+hex(bytes);
    if(hashBytes(data)!==row.dataHash)fail('RETRY_INVALID');
    verifyRotationCalldata({...row.offer,leaf:reservation.leaf},data);
    return data;
  }catch{fail('RETRY_INVALID');}finally{bytes?.fill(0);}
}
