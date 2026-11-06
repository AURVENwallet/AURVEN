import * as E from './lib/evmwots.js';
import {fromHex} from './local-proof.js';
import {fail,hex} from './vault-crypto.js';
import {createdAddress,hashBytes} from './browser-trial.js';
import {accountCodeHash,vaultSetupHash} from './contract-pin.js';

export const setup=kind=>kind==='create';
const addr=/^0x[0-9a-f]{40}$/, part=/^[0-9a-f]{32}$/;
export function validateNetworkPlan(plan) {
  if (!plan || !['create','send','rotate'].includes(plan.kind) || plan.chainId!==97 ||
      !addr.test(plan.account) || !addr.test(plan.payer) || !addr.test(plan.recipient) ||
      !Number.isSafeInteger(plan.deadline) || plan.deadline<=Date.now()/1000 || plan.deadline>Date.now()/1000+3600 ||
      plan.value!==(setup(plan.kind)?'0x3':'0x0')) fail('NET_PLAN');
  if (setup(plan.kind)) {
    if (plan.wrapper!==createdAddress(plan.payer,plan.nonce) || plan.account!==createdAddress(plan.wrapper,1)) fail('NET_PLAN');
  } else {
    const s=plan.snapshot;
    if (s?.account!==plan.account || s.chainId!==97 || s.codeHash!==accountCodeHash || !Number.isInteger(s.epoch) ||
        s.epoch<1 || s.epoch>0xffffffff || !Number.isInteger(s.next) || s.next<0 || s.next>E.LEAVES ||
        !/^0x[0-9a-f]{32}$/.test(s.root) || !/^0x[0-9a-f]{32}$/.test(s.pubSeed)) fail('NET_PLAN');
    if (plan.kind==='send' && (BigInt(plan.recipient)<=65535n || plan.recipient===plan.account)) fail('NET_PLAN');
  }
}
export function spendingLeaf(plan,journal) {
  if (setup(plan.kind)) return E.chainSlot(97);
  const s=plan.snapshot, rotation=plan.kind==='rotate';
  let leaf=Math.max(s.next,rotation?E.EXEC_LIMIT:0);
  for (const row of journal) if (row.pubSeed===s.pubSeed.slice(2) && row.root===s.root.slice(2)) leaf=Math.max(leaf,row.leaf+1);
  if (leaf>=(rotation?E.LEAVES:E.EXEC_LIMIT)) fail('NET_EXHAUSTED');
  return leaf;
}
const calls=plan=>[{to:plan.recipient,value:1n,data:new Uint8Array()}];
export function networkHasher(plan,intent) {
  const rnd=fromHex(intent.rnd),epoch=plan.snapshot?.epoch??0;
  if (plan.kind==='send') return E.execHasher(rnd,97,plan.account,epoch,intent.leaf,plan.deadline,calls(plan));
  return E.rekeyHasher(rnd,97,plan.account,epoch,intent.leaf,plan.deadline,fromHex(intent.newSeed),fromHex(intent.newRoot));
}
export function validateIntent(plan,intent,leaf) {
  if (intent.leaf!==leaf || ![intent.rnd,intent.seed,intent.root,intent.digest].every(v=>typeof v==='string' && part.test(v)) ||
      !Number.isInteger(intent.salt) || intent.salt<0 || intent.salt>0xffffffff) fail('NET_PROOF');
  if (!setup(plan.kind) && ('0x'+intent.seed!==plan.snapshot.pubSeed || '0x'+intent.root!==plan.snapshot.root)) fail('NET_KEYS');
  if (plan.kind!=='send' && (![intent.newSeed,intent.newRoot].every(v=>typeof v==='string'&&part.test(v)) ||
      intent.newRoot===intent.root || intent.newSeed===intent.seed)) fail('NET_PROOF');
  if (hex(networkHasher(plan,intent)(intent.salt))!==intent.digest) fail('NET_PROOF');
}
export function encodeNetworkAction(plan,m,proof,init) {
  if (!(proof instanceof Uint8Array) || proof.length!==E.PROOF_LEN ||
      hex(E.rootFromProof(fromHex(m.seed),m.leaf,fromHex(m.digest),proof))!==m.root) fail('NET_PROOF');
  const rnd=fromHex(m.rnd);
  if (plan.kind==='send') return '0x'+hex(E.encodeExecute(calls(plan),m.leaf,plan.deadline,m.salt,rnd,proof));
  const seed=fromHex(m.newSeed),root=fromHex(m.newRoot);
  if (plan.kind==='rotate') return '0x'+hex(E.encodeRekey(seed,root,m.leaf,plan.deadline,m.salt,rnd,proof));
  if (hashBytes(init)!==vaultSetupHash) fail('NET_PROOF');
  return init+hex(E.concat(E.addressWord(plan.account),E.leftWord(fromHex(m.seed)),E.leftWord(fromHex(m.root)),
    E.leftWord(seed),E.leftWord(root),E.word(plan.deadline),E.word(m.salt),E.leftWord(rnd),E.word(9*32),E.dynBytes(proof)));
}
