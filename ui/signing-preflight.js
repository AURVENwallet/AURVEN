import {readAccountAt} from './account-state.js';
import {createdAddress,requireTrial} from './browser-trial.js';
import {alignedTestnetHeads,primaryTestnet,secondaryTestnet,testnetClients} from './testnet-heads.js';

const quantity=/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
const address=/^0x[0-9a-f]{40}$/;
export const networkGas=Object.freeze({create:2400000n,fund:45000n,send:700000n,rotate:700000n});
const snapshotFields=['account','chainId','codeHash','epoch','next','pubSeed','root','balanceWei'];
function sameState(a,b) {
  if (!a || !b) return a===b;
  return snapshotFields.every(key=>a[key]===b[key]);
}

async function checkCreation(rpc,plan,tag) {
  for (const target of [plan.wrapper,plan.account]) {
    const [code,nonce]=await Promise.all([rpc('eth_getCode',[target,tag]),rpc('eth_getTransactionCount',[target,tag])]);
    requireTrial(code==='0x' && nonce==='0x0','NET_SETUP_OCCUPIED');
  }
  return null;
}
async function observePlan(rpc,plan,head) {
  const tag=head.number;
  requireTrial(Number(BigInt(head.timestamp))+30<plan.deadline,'TRIAL_CLOCK');
  const [nonce,pending,balance,payerCode,recipientCode,snapshot]=await Promise.all([
    rpc('eth_getTransactionCount',[plan.payer,tag]),rpc('eth_getTransactionCount',[plan.payer,'pending']),
    rpc('eth_getBalance',[plan.payer,tag]),rpc('eth_getCode',[plan.payer,tag]),
    plan.recipient===plan.payer?'0x':rpc('eth_getCode',[plan.recipient,tag]),
    plan.kind==='create'?checkCreation(rpc,plan,tag):readAccountAt(rpc,plan.account,97,head)
  ]);
  requireTrial(nonce===plan.nonce && pending===plan.nonce,'TRIAL_NONCE');
  requireTrial(payerCode==='0x' && recipientCode==='0x','TRIAL_RECIPIENT');
  requireTrial(quantity.test(balance) && BigInt(balance)>=BigInt(plan.gas)*BigInt(plan.gasPrice)+BigInt(plan.value),'TRIAL_BALANCE');
  if (snapshot) {
    requireTrial(snapshot.epoch>0,'NET_ACCOUNT');
    if (plan.kind==='send') requireTrial(BigInt(snapshot.balanceWei)>0n,'NET_BALANCE');
  }
  // Check the numbered block after all reads, including pending-nonce and creation checks.
  const confirmed=await rpc('eth_getBlockByNumber',[tag,false]);
  requireTrial(confirmed?.number===tag && confirmed.hash===head.hash,'NET_PREFLIGHT_FORK');
  return {snapshot,payerBalance:BigInt(balance)};
}

// This read-only operation receives public preview fields. Endpoint selection is never taken from a saved plan.
export async function verifyNetworkPlanState(plan,primary=primaryTestnet,secondary) {
  if (primary===primaryTestnet && secondary===undefined) secondary=secondaryTestnet;
  const clients=testnetClients(primary,secondary,AbortSignal.timeout(30000));
  requireTrial(Object.hasOwn(networkGas,plan.kind) && plan.chainId===97 && address.test(plan.account) &&
    address.test(plan.payer) && address.test(plan.recipient) && quantity.test(plan.nonce) && quantity.test(plan.gas) &&
    quantity.test(plan.gasPrice) && BigInt(plan.gas)===networkGas[plan.kind] &&
    BigInt(plan.gasPrice)>0n && BigInt(plan.gasPrice)<=5000000000n && Number.isSafeInteger(plan.deadline) && plan.deadline<=Date.now()/1000+3600 &&
    plan.value===(['create','fund'].includes(plan.kind)?'0x3':'0x0'),'NET_PLAN');
  requireTrial(plan.kind==='send'?(BigInt(plan.recipient)>0xffffn && plan.recipient!==plan.account):
    plan.recipient===plan.payer,'NET_PLAN');
  if (plan.kind==='create') requireTrial(plan.wrapper===createdAddress(plan.payer,plan.nonce) &&
    plan.account===createdAddress(plan.wrapper,1),'NET_PLAN');
  const {latest,aligned,conflict}=await alignedTestnetHeads(clients);
  requireTrial(aligned.every(Boolean),'NET_PREFLIGHT_UNAVAILABLE');
  requireTrial(!conflict,'NET_PREFLIGHT_FORK');
  const common=aligned[0],review=plan.reviewBlock;
  requireTrial(Math.abs(Date.now()/1000-Number(BigInt(common.timestamp)))<=30,'NET_PREFLIGHT_UNAVAILABLE');
  if (review) {
    requireTrial(quantity.test(review.number) && /^0x[0-9a-f]{64}$/i.test(review.hash) &&
      BigInt(common.number)>=BigInt(review.number),'DRAFT_STALE');
  }
  try {
    const states=await Promise.all(clients.map(async(rpc,i)=>{
      if (review) {
        const anchor=common.number===review.number?aligned[i]:await rpc('eth_getBlockByNumber',[review.number,false]);
        requireTrial(anchor?.number===review.number && anchor.hash===review.hash,'DRAFT_STALE');
      }
      const atCommon=await observePlan(rpc,plan,aligned[i]);
      if (latest[i].number!==common.number) {
        // Also stop when the leading node already sees a later signing state.
        const newer=await observePlan(rpc,plan,latest[i]);
        requireTrial(sameState(atCommon.snapshot,newer.snapshot),'DRAFT_STALE');
        const anchor=await rpc('eth_getBlockByNumber',[common.number,false]);
        requireTrial(anchor?.number===common.number && anchor.hash===common.hash,'NET_PREFLIGHT_FORK');
      }
      return atCommon;
    }));
    requireTrial(sameState(states[0].snapshot,states[1].snapshot) && states[0].payerBalance===states[1].payerBalance,
      'NET_PREFLIGHT_STATE');
    requireTrial(Math.abs(Date.now()/1000-Number(BigInt(common.timestamp)))<=30,'NET_PREFLIGHT_UNAVAILABLE');
    if (plan.snapshot) requireTrial(sameState(plan.snapshot,states[0].snapshot),'DRAFT_STALE');
    return {snapshot:states[0].snapshot,reviewBlock:{number:common.number,hash:common.hash}};
  } catch (error) {
    if (/^(NET_|TRIAL_|DRAFT_STALE$)/.test(error.message)) throw error;
    throw new Error('NET_PREFLIGHT_UNAVAILABLE',{cause:error});
  }
}
