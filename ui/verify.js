import vector from "./vector.js";
import {rootFromProof} from "./lib/evmwots.js";
const bytes = hex => Uint8Array.from(hex.match(/../g), pair => parseInt(pair,16));
export function verify(tamper=false, onLevel){
  const proof = bytes(vector.proof);
  if(tamper) proof[0] ^= 1;
  const root = rootFromProof(bytes(vector.seed),0,bytes(vector.digest),proof,onLevel);
  return Array.from(root, x => x.toString(16).padStart(2,"0")).join("");
}


