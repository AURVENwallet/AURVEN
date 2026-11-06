import {accountRpc,readAccount} from './account-state.js';
import {localSimulationEndpoint} from './local-transfer.js';
import {keccak256} from './lib/keccak.js';
import {EXEC_LIMIT,leftWord,word,rekeyHasher,grind,encodeRekey,rootFromProof} from './lib/evmwots.js';
import {verifyRotationCalldata} from './rotation-calldata.js';
import {fromHex} from './local-proof.js';
import {hex,fail,validateOffer,handoverFields} from './vault-crypto.js';
export {validateOffer};

const format='aurven-local-handover-v1';
const text=new TextEncoder();
const rekeyTopic='0x'+hex(keccak256(text.encode('Rekeyed(uint32,bytes16,bytes16)')));
const matches=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const bytes=value=>fromHex(value.slice(2));

export function makeOffer(state,newSeed,newRoot) {
  return validateOffer({format,chainId:state.chainId,account:state.account,epoch:state.epoch,
    oldSeed:state.pubSeed,oldRoot:state.root,newSeed,newRoot,deadline:state.timestamp+900});
}
export function offerFingerprint(offer) {
  validateOffer(offer);
  return hex(keccak256(text.encode(JSON.stringify(handoverFields.map(k=>offer[k]))))).slice(0,32);
}
export function checkSource(offer,state) {
  validateOffer(offer);
  if (state.chainId!==31337 || state.account!==offer.account || state.epoch!==1 ||
      state.root!==offer.oldRoot || state.pubSeed!==offer.oldSeed || state.next>EXEC_LIMIT ||
      state.timestamp+10>=offer.deadline || offer.deadline>state.timestamp+900) fail('HANDOVER_STALE');
}
export function rotationMessage(offer) {
  const rnd=crypto.getRandomValues(new Uint8Array(16));
  const {digest,salt}=grind(rotationHasher(offer,rnd),256);
  return {rnd:hex(rnd),digest:hex(digest),salt};
}
export const rotationHasher=(offer,rnd)=>rekeyHasher(rnd,31337,offer.account,1,EXEC_LIMIT,offer.deadline,bytes(offer.newSeed),bytes(offer.newRoot));
export function rotationCalldata(offer,message,proof) {
  const rnd=fromHex(message.rnd);
  const digest=rotationHasher(offer,rnd)(message.salt);
  if (hex(digest)!==message.digest || '0x'+hex(rootFromProof(bytes(offer.oldSeed),EXEC_LIMIT,digest,proof))!==offer.oldRoot) fail('HANDOVER_PROOF');
  return '0x'+hex(encodeRekey(bytes(offer.newSeed),bytes(offer.newRoot),EXEC_LIMIT,offer.deadline,message.salt,rnd,proof));
}
export function verifyRotationInput(offer,input) {
  validateOffer(offer);
  verifyRotationCalldata({...offer,leaf:EXEC_LIMIT},input);
}
export async function localNode(endpoint) {
  if (!localSimulationEndpoint(endpoint,31337) || new URL(endpoint).hostname!=='127.0.0.1') fail('SIGN_LOCAL');
  const rpc=accountRpc(endpoint);
  if (await rpc('eth_chainId')!=='0x7a69' || !/^anvil\b/i.test(await rpc('web3_clientVersion'))) fail('SIGN_LOCAL');
  return rpc;
}
export async function readHandoverState(endpoint,account) {
  await localNode(endpoint);
  return readAccount({endpoint,account,chainId:31337});
}
// The disposable launcher starts Anvil without any unlocked accounts. Only its local payer pays gas.
export async function sendLocalRotation(endpoint,offer,data,checkSession) {
  const rpc=await localNode(endpoint);
  checkSource(offer,await readHandoverState(endpoint,offer.account));
  const payer='0x'+hex(crypto.getRandomValues(new Uint8Array(20)));
  const tx={from:payer,to:offer.account,data,gas:'0xaae60',value:'0x0'};
  await rpc('anvil_setBalance',[payer,'0xde0b6b3a7640000']);
  await rpc('anvil_impersonateAccount',[payer]);
  try {
    checkSession();
    if (await rpc('eth_call',[tx,'latest'])!=='0x') fail('HANDOVER_PROOF');
    checkSession();
    const hash=await rpc('eth_sendTransaction',[tx]);
    if (!/^0x[0-9a-f]{64}$/.test(hash)) fail('HANDOVER_RECEIPT');
    return hash;
  } finally {await rpc('anvil_stopImpersonatingAccount',[payer]);}
}

export async function confirmLocalHandover(endpoint,offer) {
  validateOffer(offer);
  const rpc=await localNode(endpoint),state=await readAccount({endpoint,account:offer.account,chainId:31337});
  if (state.epoch!==2 || state.pubSeed!==offer.newSeed || state.root!==offer.newRoot) fail('HANDOVER_PENDING');
  const topics=[rekeyTopic,'0x'+hex(word(2))], data='0x'+hex(leftWord(bytes(offer.newSeed)))+hex(leftWord(bytes(offer.newRoot)));
  const logs=await rpc('eth_getLogs',[{address:offer.account,fromBlock:'0x0',toBlock:state.blockNumber,topics}]);
  const match=log=>log && !log.removed && matches(log.address,offer.account) && log.topics?.length===2 &&
    topics.every((v,i)=>matches(v,log.topics[i])) && matches(log.data,data);
  if (!Array.isArray(logs) || logs.length!==1 || !match(logs[0])) fail('HANDOVER_RECEIPT');
  const log=logs[0],hash=log.transactionHash;
  if (!/^0x[0-9a-f]{64}$/.test(hash) || !/^0x[0-9a-f]+$/.test(log.blockNumber)) fail('HANDOVER_RECEIPT');
  if (BigInt(state.blockNumber)<=BigInt(log.blockNumber)) fail('HANDOVER_PENDING');
  const [tx,receipt,block,head]=await Promise.all([rpc('eth_getTransactionByHash',[hash]),rpc('eth_getTransactionReceipt',[hash]),
    rpc('eth_getBlockByNumber',[log.blockNumber,false]),rpc('eth_getBlockByNumber',[state.blockNumber,false])]);
  if (tx?.hash!==hash || tx.chainId!=='0x7a69' || !matches(tx.to,offer.account) || tx.value!=='0x0' ||
      tx.blockHash!==log.blockHash || tx.blockNumber!==log.blockNumber ||
      receipt?.status!=='0x1' || !matches(receipt.to,offer.account) || receipt.transactionHash!==hash ||
      receipt.blockNumber!==log.blockNumber || block?.number!==log.blockNumber || block.hash!==log.blockHash ||
      receipt.blockHash!==block.hash || !block.transactions.includes(hash) || head?.hash!==state.blockHash ||
      !receipt.logs.some(item=>match(item)&&item.transactionHash===hash&&item.blockHash===block.hash&&item.logIndex===log.logIndex)) fail('HANDOVER_RECEIPT');
  verifyRotationInput(offer,tx.input);
  return {hash,blockNumber:log.blockNumber,blockHash:block.hash,root:state.root,epoch:state.epoch};
}
