import {accountRpc,readAccount} from './account-state.js';
import {HASH} from './activity-rpc.js';
import {previewTrial,checkBeforeSend,q,requireTrial} from './browser-trial.js';
import {startTrial,updateTrial} from './browser-trial-store.js';
import {networkReceipt,compareNetworkReceipts,digestData} from './network-receipt.js';
import {keccak256} from './lib/keccak.js';
import {hex} from './test-wallet-core.js';

export {networkReceipt};
const badSignature='0x'+hex(keccak256(new TextEncoder().encode('BadSignature()'))).slice(0,8);
export async function previewNetwork(endpoint,{walletId,payer,account,kind,recipient}) {
  requireTrial(['create','send','rotate','fund'].includes(kind),'NET_PLAN');
  const value=kind==='create'||kind==='fund'?3n:0n;
  const gas=kind==='create'?2400000n:kind==='fund'?45000n:700000n;
  const rpc=accountRpc(endpoint);
  const plan=await previewTrial(rpc,payer,kind==='send'?recipient:payer,{gas,value});
  Object.assign(plan,{walletId,chainId:97,kind,value:q(value)});
  if (kind!=='create') {
    requireTrial(/^0x[0-9a-f]{40}$/.test(account),'NET_ACCOUNT');
    plan.account=account;
    plan.snapshot=await readAccount({endpoint,account,chainId:97});
    requireTrial(plan.snapshot.epoch>0,'NET_ACCOUNT');
    if (kind==='send') requireTrial(plan.recipient!==account && BigInt(plan.snapshot.balanceWei)>0n,'NET_BALANCE');
  }
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
export async function submitNetwork({endpoint,store,provider,plan,authorize,walletId}) {
  const rpc=accountRpc(endpoint);
  requireTrial(walletId()===plan.walletId,'NET_VAULT');
  await checkBeforeSend(rpc,provider,plan);
  await startTrial(store,plan,retainNetworkHistory);
  let requested=false;
  try {
    const {data,intent}=plan.kind==='fund'?{data:'0x',intent:null}:await authorize(plan);
    requireTrial(walletId()===plan.walletId,'NET_VAULT');
    await checkBeforeSend(rpc,provider,plan);
    await updateTrial(store,plan.id,row=>({...row,status:'requested',dataHash:digestData(data),intent}));
    requested=true;
    const tx={from:plan.payer,nonce:plan.nonce,chainId:'0x61',gas:plan.gas,gasPrice:plan.gasPrice,value:plan.value,data};
    if (plan.kind!=='create') tx.to=plan.account;
    const hash=await provider.request({method:'eth_sendTransaction',params:[tx]});
    requireTrial(HASH.test(hash),'TRIAL_REPLY');
    return await updateTrial(store,plan.id,row=>({...row,checkToken:null,submittedHash:hash.toLowerCase(),
      status:row.status==='requested'?'waiting':row.status,hash:row.hash??hash.toLowerCase()}));
  } catch (e) {
    if (requested && e.code!==4001) throw new Error('TRIAL_REPLY',{cause:e});
    await updateTrial(store,plan.id,row=>{
      if (requested && row.status!=='requested') return row;
      return {...row,checkToken:null,status:requested?'declined':'stopped'};
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
