import {accountRpc,readAccount} from './account-state.js';
import {checkTransaction,HASH} from './activity-rpc.js';
import {previewTrial,checkBeforeSend,hashBytes,findByNonce,q,requireTrial} from './browser-trial.js';
import {startTrial,updateTrial} from './browser-trial-store.js';
import {accountCodeHash} from './contract-pin.js';
import {keccak256} from './lib/keccak.js';
import {hex} from './test-wallet-core.js';
import {word,leftWord} from './lib/evmwots.js';
import {fromHex} from './local-proof.js';

const topic=name=>'0x'+hex(keccak256(new TextEncoder().encode(name)));
const rekeyed=topic('Rekeyed(uint32,bytes16,bytes16)');
const emptyHash='0x'+hex(keccak256(new Uint8Array()));
const digestData=data=>data==='0x'?emptyHash:hashBytes(data);
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
// This history holds public receipts. The encrypted one-time leaf journal is separate and never pruned.
export function retainNetworkHistory(rows,plan) {
  const now=Date.now()/1000;
  function removable(row) {
    if (['declined','stopped','reverted'].includes(row.status)) return true;
    if (row.status==='preparing' && row.deadline<=now) return true;
    return row.status==='included' && row.kind!=='create';
  }
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
    return await updateTrial(store,plan.id,row=>({...row,status:'waiting',hash:hash.toLowerCase()}));
  } catch (e) {
    if (requested && e.code!==4001) throw new Error('TRIAL_REPLY',{cause:e});
    await updateTrial(store,plan.id,row=>({...row,status:requested?'declined':'stopped'}));
    throw e;
  }
}
export async function networkReceipt(endpoint,row,manualHash) {
  const rpc=accountRpc(endpoint);
  requireTrial(await rpc('eth_chainId')==='0x61','TRIAL_CHAIN');
  let hash=manualHash||row.hash;
  if (!hash) hash=await findByNonce(rpc,row,BigInt(await rpc('eth_blockNumber')));
  if (!hash) return {status:'waiting'};
  requireTrial(HASH.test(hash),'TRIAL_HASH');
  const tx=await rpc('eth_getTransactionByHash',[hash]);
  if (!tx) return {status:'waiting'};
  const create=row.kind==='create';
  requireTrial(tx.chainId==='0x61' && tx.from?.toLowerCase()===row.payer && tx.to?.toLowerCase()===(create?undefined:row.account) &&
    tx.nonce===row.nonce && BigInt(tx.value)===BigInt(row.value) && digestData(tx.input)===row.dataHash,'TRIAL_HASH');
  if (!tx.blockHash) return {status:'waiting',hash};
  const receipt=await rpc('eth_getTransactionReceipt',[hash]);
  if (!receipt) return {status:'waiting',hash};
  if (receipt.status==='0x0') {
    const b=await rpc('eth_getBlockByNumber',[tx.blockNumber,false]);
    requireTrial(b?.hash===tx.blockHash && receipt.blockHash===b.hash && receipt.transactionHash===hash && b.transactions.includes(hash),'TRIAL_RECEIPT');
    return {status:'reverted',hash};
  }
  const observed=await checkTransaction({endpoint,chainId:97,account:create?row.wrapper:row.account,hash});
  if (observed.status!=='included') return {status:'waiting',hash};
  requireTrial(receipt.blockHash===observed.inclusion.blockHash,'TRIAL_RECEIPT');
  if (create || row.kind==='rotate') {
    const epoch=create?1:row.snapshot.epoch+1;
    const data='0x'+hex(leftWord(fromHex(row.intent.newSeed)))+hex(leftWord(fromHex(row.intent.newRoot)));
    requireTrial(receipt.logs.some(log=>!log.removed && log.transactionHash===hash && log.blockHash===receipt.blockHash &&
      log.address.toLowerCase()===row.account && log.topics.length===2 && log.topics[0]===rekeyed &&
      log.topics[1]==='0x'+hex(word(epoch)) && log.data===data),'TRIAL_RECEIPT');
  } else if (row.kind==='send') {
    const [event]=observed.inclusion.executions;
    requireTrial(observed.inclusion.executions.length===1 && event.epoch===row.snapshot.epoch &&
      event.leaf===row.intent.leaf && event.digest==='0x'+row.intent.digest,'TRIAL_RECEIPT');
  }
  requireTrial(hashBytes(await rpc('eth_getCode',[row.account,'latest']))===accountCodeHash,'TRIAL_RECEIPT');
  requireTrial((await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]))?.hash===receipt.blockHash,'TRIAL_RECEIPT');
  return {status:'included',hash,block:receipt.blockNumber,gasUsed:BigInt(receipt.gasUsed).toString(),feeWei:observed.inclusion.feeWei};
}

export async function checkOldApproval(endpoint,row) {
  requireTrial(row?.kind==='send' && row.status==='included' && HASH.test(row.hash),'NET_OLD');
  const result=await networkReceipt(endpoint,row);
  requireTrial(result.status==='included','TRIAL_RECEIPT');
  const rpc=accountRpc(endpoint),state=await readAccount({endpoint,account:row.account,chainId:97});
  requireTrial(state.epoch>row.snapshot.epoch && state.root!==row.snapshot.root,'NET_OLD');
  requireTrial(state.timestamp<=row.deadline && state.next<=row.intent.leaf,'NET_WINDOW');
  const tx=await rpc('eth_getTransactionByHash',[row.hash]);
  requireTrial(digestData(tx.input)===row.dataHash,'TRIAL_HASH');
  try {await rpc('eth_call',[{from:row.payer,to:row.account,data:tx.input},state.blockNumber]);}
  catch (e) {
    if (e.revertData?.toLowerCase()!==topic('BadSignature()').slice(0,10)) throw new Error('NET_NO_REJECTION');
    requireTrial((await rpc('eth_getBlockByNumber',[state.blockNumber,false]))?.hash===state.blockHash,'TRIAL_RECEIPT');
    return {block:state.blockNumber,epoch:state.epoch,reason:'BadSignature'};
  }
  throw new Error('NET_NO_REJECTION');
}
