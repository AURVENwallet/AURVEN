import {networkGas,verifyNetworkPlanState} from './signing-preflight.js';
import {accountRpc,readAccount} from './account-state.js';
import {HASH} from './activity-rpc.js';
import {previewTrial,payerAccount,q,requireTrial} from './browser-trial.js';
import {startTrial,updateTrial} from './browser-trial-store.js';
import {networkReceipt,compareNetworkReceipts,digestData} from './network-receipt.js';
import {keccak256} from './lib/keccak.js';
import {hex} from './test-wallet-core.js';

export {networkReceipt};
const badSignature='0x'+hex(keccak256(new TextEncoder().encode('BadSignature()'))).slice(0,8);
export async function previewNetwork(endpoint,{walletId,payer,account,kind,recipient},secondary) {
  requireTrial(['create','send','rotate','fund'].includes(kind),'NET_PLAN');
  const value=kind==='create'||kind==='fund'?3n:0n;
  const gas=networkGas[kind];
  const rpc=accountRpc(endpoint);
  let plan;
  try {
    plan=await previewTrial(rpc,payer,kind==='send'?recipient:payer,{gas,value});
  } catch (error) {
    if (error.message?.startsWith('TRIAL_')) throw error;
    throw new Error('NET_PREFLIGHT_UNAVAILABLE',{cause:error});
  }
  Object.assign(plan,{walletId,chainId:97,kind,value:q(value)});
  if (kind!=='create') {
    requireTrial(/^0x[0-9a-f]{40}$/.test(account),'NET_ACCOUNT');
    plan.account=account;
  }
  const checked=await verifyNetworkPlanState(plan,endpoint,secondary);
  if (checked.snapshot) plan.snapshot=checked.snapshot;
  plan.reviewBlock=checked.reviewBlock;
  return plan;
}
export function needsReceiptCheck(row) {
  return !!row.receiptCheck && row.receiptCheck.kind!=='agreed';
}
// This history holds public receipts. The encrypted one-time leaf journal is separate and never pruned.
export function retainNetworkHistory(rows,plan) {
  if (plan.kind!=='create') {
    const uncertainCreation=rows.some(row=>row.kind==='create' && row.account===plan.account &&
      row.walletId===plan.walletId && needsReceiptCheck(row));
    requireTrial(!uncertainCreation,'NET_ACCOUNT_CHECK');
  }
  const now=Date.now()/1000;
  function removable(row) {
    if (needsReceiptCheck(row)) return false;
    if (['declined','stopped','reverted','replaced','expired'].includes(row.status)) return true;
    if (row.status==='preparing' && row.deadline<=now) return true;
    return row.status==='included' && row.kind!=='create';
  }
  const unresolved=['requested','waiting','pending','unseen','reorg'];
  const conflict=rows.some(row=>row.payer===plan.payer && row.nonce===plan.nonce && (unresolved.includes(row.status) || needsReceiptCheck(row)) &&
    (row.kind==='fund' || row.deadline>=now));
  requireTrial(!conflict,'TRIAL_IN_USE');
  if (plan.kind==='create') {
    const creations=rows.filter(row=>row.kind==='create' && !removable(row));
    requireTrial(creations.length<8,'NET_ACCOUNT_LIMIT');
  }
  if (rows.length<32) return rows;
  const index=rows.findIndex(removable);
  requireTrial(index>=0,'NET_HISTORY_FULL');
  return rows.filter((_,i)=>i!==index);
}
export async function submitNetwork({endpoint,secondary,store,provider,plan,authorize,walletId}) {
  requireTrial(plan.reviewBlock && (plan.kind==='create' || plan.snapshot),'DRAFT_STALE');
  requireTrial(walletId()===plan.walletId,'NET_VAULT');
  requireTrial(await payerAccount(provider)===plan.payer,'TRIAL_PAYER');
  await verifyNetworkPlanState(plan,endpoint,secondary);
  await startTrial(store,plan,retainNetworkHistory);
  let requested=false,leafReserved=false;
  try {
    const {data,intent}=plan.kind==='fund'?{data:'0x',intent:null}:await authorize(plan);
    leafReserved=plan.kind!=='fund';
    requireTrial(walletId()===plan.walletId,'NET_VAULT');
    await verifyNetworkPlanState(plan,endpoint,secondary);
    requireTrial(await payerAccount(provider)===plan.payer,'TRIAL_PAYER');
    await updateTrial(store,plan.id,row=>({...row,status:'requested',dataHash:digestData(data),intent}));
    requireTrial(walletId()===plan.walletId,'NET_VAULT');
    requested=true;
    const tx={from:plan.payer,nonce:plan.nonce,chainId:'0x61',gas:plan.gas,gasPrice:plan.gasPrice,value:plan.value,data};
    if (plan.kind!=='create') tx.to=plan.account;
    const hash=await provider.request({method:'eth_sendTransaction',params:[tx]});
    requireTrial(HASH.test(hash),'TRIAL_REPLY');
    return await updateTrial(store,plan.id,row=>({...row,checkToken:null,submittedHash:hash.toLowerCase(),
      status:row.status==='requested'?'waiting':row.status,hash:row.hash??hash.toLowerCase()}));
  } catch (e) {
    if (requested && e.code!==4001) throw new Error('TRIAL_REPLY',{cause:e});
    leafReserved=leafReserved || e.leafReserved===true;
    await updateTrial(store,plan.id,row=>{
      if (requested && row.status!=='requested') return row;
      return {...row,checkToken:null,leafReserved,status:requested?'declined':'stopped'};
    });
    throw e;
  }
}
// A slower tab cannot overwrite a later check or a wallet response received during its lookup.
export async function reconcileNetwork(store,endpoint,id,manualHash,secondary) {
  const token=crypto.randomUUID();
  const row=await updateTrial(store,id,old=>{
    requireTrial(!!old.dataHash,'TRIAL_STORAGE');
    return {...old,checkToken:token};
  });
  const {check,observation}=secondary
    ?await compareNetworkReceipts(endpoint,secondary,row,manualHash)
    :{check:null,observation:await networkReceipt(endpoint,row,manualHash)};
  return updateTrial(store,id,current=>{
    requireTrial(current.checkToken===token,'NET_CHECK_AGAIN');
    return {...current,...observation,receiptCheck:check,checkToken:null};
  });
}

export async function checkOldApproval(endpoint,row) {
  requireTrial(row?.kind==='send' && row.status==='included' && HASH.test(row.hash),'NET_OLD');
  const result=await networkReceipt(endpoint,row);
  requireTrial(result.status==='included','TRIAL_RECEIPT');
  const rpc=accountRpc(endpoint),state=await readAccount({endpoint,account:row.account,chainId:97});
  requireTrial(state.epoch>row.snapshot.epoch && state.root!==row.snapshot.root,'NET_OLD');
  requireTrial(state.timestamp<=row.deadline && state.next<=row.intent.leaf,'NET_WINDOW');
  const tx=await rpc('eth_getTransactionByHash',[result.hash]);
  requireTrial(digestData(tx.input)===row.dataHash,'TRIAL_HASH');
  try {await rpc('eth_call',[{from:row.payer,to:row.account,data:tx.input},state.blockNumber]);}
  catch (e) {
    if (e.revertData?.toLowerCase()!==badSignature) throw new Error('NET_NO_REJECTION');
    requireTrial((await rpc('eth_getBlockByNumber',[state.blockNumber,false]))?.hash===state.blockHash,'TRIAL_RECEIPT');
    return {block:state.blockNumber,epoch:state.epoch,reason:'BadSignature'};
  }
  throw new Error('NET_NO_REJECTION');
}
