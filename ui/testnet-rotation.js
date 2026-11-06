import {readAccountAt} from './account-state.js';
import {findByNonce,q} from './browser-trial.js';
import {digestData,verifyNetworkEvents} from './network-receipt.js';
import {alignedTestnetHeads,readTestnetHead,primaryTestnet,secondaryTestnet,testnetClients} from './testnet-heads.js';
import {EXEC_LIMIT,LEAVES} from './lib/evmwots.js';
import {verifyRotationCalldata} from './rotation-calldata.js';

const format='aurven-testnet-rotation-record-v1';
const fields=['format','chainId','account','payer','nonce','startBlock','epoch','leaf','deadline','oldSeed','oldRoot','newSeed','newRoot','dataHash'];
const addr=/^0x[0-9a-f]{40}$/, hash=/^0x[0-9a-f]{64}$/, part=/^0x[0-9a-f]{32}$/;
const quantity=/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/;
const valid=(pattern,v)=>typeof v==='string'&&pattern.test(v);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const requireCheck=(ok,code)=>{if(!ok)throw new Error(code);};
export function validateRotationRecord(r){
  requireCheck(r && Object.keys(r).length===fields.length && fields.every(k=>Object.hasOwn(r,k)) &&
    r.format===format && r.chainId===97 && valid(addr,r.account) && valid(addr,r.payer) &&
    valid(quantity,r.nonce) && valid(quantity,r.startBlock) && Number.isInteger(r.epoch) && r.epoch>0 && r.epoch<0xffffffff &&
    Number.isInteger(r.leaf) && r.leaf>=EXEC_LIMIT && r.leaf<LEAVES && Number.isSafeInteger(r.deadline) && r.deadline>0 &&
    ['oldSeed','oldRoot','newSeed','newRoot'].every(k=>valid(part,r[k])) && r.oldRoot!==r.newRoot && r.oldSeed!==r.newSeed &&
    valid(hash,r.dataHash),'ROTATION_FILE');
  return r;
}
export function exportRotationRecord(row){
  requireCheck(row?.kind==='rotate' && row.intent && row.snapshot,'ROTATION_FILE');
  return validateRotationRecord({format,chainId:row.chainId,account:row.account,payer:row.payer,nonce:row.nonce,
    startBlock:row.startBlock,epoch:row.snapshot.epoch,leaf:row.intent.leaf,deadline:row.deadline,oldSeed:row.snapshot.pubSeed,
    oldRoot:row.snapshot.root,newSeed:'0x'+row.intent.newSeed,newRoot:'0x'+row.intent.newRoot,dataHash:row.dataHash});
}
async function both(jobs){
  const results=await Promise.allSettled(jobs);
  for(const result of results)if(result.status==='rejected')throw result.reason;
  return results.map(result=>result.value);
}
async function anchor(rpc,head){
  const [finalized,canonical]=await Promise.all([readTestnetHead(rpc,'finalized'),rpc('eth_getBlockByNumber',[head.number,false])]);
  requireCheck(BigInt(finalized.number)>=BigInt(head.number) && canonical?.number===head.number && same(canonical.hash,head.hash) &&
    (finalized.number!==head.number||same(finalized.hash,head.hash)),'ROTATION_CONFLICT');
}
async function validateCursor(clients,cursor,head,r){
  requireCheck(cursor.dataHash===r.dataHash && valid(quantity,cursor.number)&&valid(hash,cursor.hash)&&BigInt(cursor.number)>=BigInt(r.startBlock) &&
    BigInt(cursor.number)<=BigInt(head.number),'ROTATION_CURSOR');
  const blocks=await both(clients.map(rpc=>rpc('eth_getBlockByNumber',[cursor.number,false])));
  requireCheck(blocks.every(b=>b?.number===cursor.number&&same(b.hash,cursor.hash)),'ROTATION_CURSOR');
}
// Nodes can retain block bodies after pruning the historical nonce trie and disabling log filters.
async function scanBlocks(rpc,r,start,end,previous){
  let parent=previous;
  for(let first=start;first<=end;first+=4n){
    const batch=[];
    for(let n=first;n<=end&&n<first+4n;n++)batch.push(rpc('eth_getBlockByNumber',[q(n),true]));
    const blocks=await Promise.all(batch);
    for(const [index,b] of blocks.entries()){
      requireCheck(b?.number===q(first+BigInt(index)) && valid(hash,b.hash) && valid(hash,b.parentHash) &&
        (!parent||same(b.parentHash,parent)) && Array.isArray(b.transactions),'ROTATION_HISTORY');
      parent=b.hash;
      for(const tx of b.transactions){
        requireCheck(valid(hash,tx?.hash) && valid(addr,tx.from?.toLowerCase()) && valid(quantity,tx.nonce),'ROTATION_HISTORY');
        if(same(tx.from,r.payer) && tx.nonce===r.nonce)return {hash:tx.hash,at:b.number,blockHash:b.hash};
      }
    }
  }
  return {hash:null,at:q(end),blockHash:parent};
}
async function discover(clients,r,head,cursor){
  const height=BigInt(head.number);
  if(BigInt(r.startBlock)>height)return {status:'waiting'};
  const counts=await both(clients.map(rpc=>rpc('eth_getTransactionCount',[r.payer,head.number])));
  requireCheck(counts.every(v=>valid(quantity,v))&&counts[0]===counts[1],'ROTATION_CONFLICT');
  if(BigInt(counts[0])<=BigInt(r.nonce))return {status:Number(BigInt(head.timestamp))>r.deadline?'expired':'waiting'};
  if(!cursor){
    const lookups=await Promise.allSettled(clients.map(rpc=>findByNonce(rpc,r,height)));
    const hashes=new Set(lookups.filter(v=>v.status==='fulfilled'&&valid(hash,v.value)).map(v=>v.value));
    requireCheck(hashes.size<=1,'ROTATION_CONFLICT');
    if(hashes.size)return {hash:[...hashes][0]};
  }
  const start=cursor?BigInt(cursor.number)+1n:BigInt(r.startBlock);
  if(start>height)return {status:'not-found',cursor};
  const end=start+15n<height?start+15n:height;
  const [a,b]=await both(clients.map(rpc=>scanBlocks(rpc,r,start,end,cursor?.hash)));
  requireCheck(a.at===b.at && a.blockHash===b.blockHash && a.hash===b.hash,'ROTATION_CONFLICT');
  return a.hash?{hash:a.hash}:{status:end<height?'continue':'not-found',cursor:{number:a.at,hash:a.blockHash,dataHash:r.dataHash}};
}
async function inspect(rpc,r,txHash,head){
  const tx=await rpc('eth_getTransactionByHash',[txHash]);
  requireCheck(tx && same(tx.hash,txHash) && tx.chainId==='0x61' && same(tx.from,r.payer) && tx.nonce===r.nonce,'ROTATION_TX');
  if(tx.blockNumber===null || (valid(quantity,tx.blockNumber)&&BigInt(tx.blockNumber)>BigInt(head.number)))return {status:'waiting'};
  requireCheck(valid(quantity,tx.blockNumber)&&valid(hash,tx.blockHash),'ROTATION_HISTORY');
  const [receipt,block]=await Promise.all([rpc('eth_getTransactionReceipt',[txHash]),rpc('eth_getBlockByNumber',[tx.blockNumber,false])]);
  requireCheck(receipt && same(receipt.transactionHash,txHash) && same(receipt.from,tx.from) &&
    (tx.to===null?receipt.to===null:same(receipt.to,tx.to)) && receipt.blockNumber===tx.blockNumber && block?.number===tx.blockNumber &&
    same(block.hash,tx.blockHash) && same(block.hash,receipt.blockHash) && Array.isArray(block.transactions) &&
    block.transactions.some(h=>same(h,txHash)) && ['0x0','0x1'].includes(receipt.status) &&
    Array.isArray(receipt.logs) && receipt.logs.length<=4096 && (receipt.status==='0x1'||receipt.logs.length===0),'ROTATION_HISTORY');
  const included={hash:txHash,block:tx.blockNumber,blockHash:block.hash.toLowerCase()};
  if(!same(tx.to,r.account)||tx.value!=='0x0'||digestData(tx.input)!==r.dataHash)return {...included,status:'replaced'};
  if(receipt.status==='0x0')return {...included,status:'reverted'};
  verifyRotationCalldata(r,tx.input);
  verifyNetworkEvents(receipt,{kind:'rotate',account:r.account,snapshot:{epoch:r.epoch},
    intent:{newSeed:r.newSeed.slice(2),newRoot:r.newRoot.slice(2)}});
  const state=await readAccountAt(rpc,r.account,97,head);
  requireCheck(state.epoch>r.epoch && (state.epoch!==r.epoch+1 || (same(state.root,r.newRoot) && same(state.pubSeed,r.newSeed))),'ROTATION_CONFLICT');
  return {...included,status:state.epoch===r.epoch+1?'current':'superseded',epoch:state.epoch,
    root:state.root.toLowerCase(),pubSeed:state.pubSeed.toLowerCase()};
}
export async function recoverTestnetRotation(record,{txHash='',cursor=null,signal=AbortSignal.timeout(90000)}={}){
  const r=validateRotationRecord(structuredClone(record));
  if(txHash)requireCheck(valid(hash,txHash),'ROTATION_TX');
  const clients=testnetClients(primaryTestnet,secondaryTestnet,signal);
  const {aligned,conflict}=await alignedTestnetHeads(clients,'finalized');
  requireCheck(!conflict,'ROTATION_CONFLICT');
  requireCheck(aligned.every(Boolean),'ROTATION_NODES');
  const head=aligned[0];
  if(cursor)await validateCursor(clients,cursor,head,r);
  let result=txHash?{hash:txHash}:await discover(clients,r,head,cursor);
  if(result.hash){
    const [a,b]=await both(clients.map(rpc=>inspect(rpc,r,result.hash,head)));
    requireCheck(Object.keys(a).length===Object.keys(b).length && Object.keys(a).every(k=>a[k]===b[k]),'ROTATION_CONFLICT');
    result=a;
  }
  await both(clients.map(rpc=>anchor(rpc,head)));
  return {...result,checkedBlock:head.number,checkedBlockHash:head.hash,account:r.account};
}
