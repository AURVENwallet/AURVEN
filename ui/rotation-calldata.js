import {encodeRekey,PROOF_LEN,rekeyHasher,rootFromProof} from './lib/evmwots.js';
import {fromHex} from './local-proof.js';
import {hex,fail} from './vault-crypto.js';

// Verify the signed arguments against an independently supplied rotation record.
// The fixed ABI layout is seven argument words, a length word and a 448-byte proof.
export function verifyRotationCalldata({account,chainId,epoch,leaf,deadline,oldSeed,oldRoot,newSeed,newRoot},input) {
  const head=10, width=64, proofStart=head+8*width;
  if(typeof input!=='string'||input.length!==proofStart+2*PROOF_LEN||!/^0x[0-9a-f]+$/.test(input))fail('HANDOVER_PROOF');
  const salt=Number(BigInt('0x'+input.slice(head+4*width,head+5*width)));
  if(!Number.isInteger(salt)||salt>0xffffffff)fail('HANDOVER_PROOF');
  const rnd=fromHex(input.slice(head+5*width,head+5*width+32)),proof=fromHex(input.slice(proofStart));
  const seed=fromHex(newSeed.slice(2)),root=fromHex(newRoot.slice(2));
  const encoded=encodeRekey(seed,root,leaf,deadline,salt,rnd,proof);
  const digest=rekeyHasher(rnd,chainId,account,epoch,leaf,deadline,seed,root)(salt);
  if('0x'+hex(encoded)!==input||'0x'+hex(rootFromProof(fromHex(oldSeed.slice(2)),leaf,digest,proof))!==oldRoot)fail('HANDOVER_PROOF');
}
