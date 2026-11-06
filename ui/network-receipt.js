import {accountRpc} from './account-state.js';
import {ADDRESS,HASH,executionEvents} from './activity-rpc.js';
import {findByNonce,hashBytes,requireTrial} from './browser-trial.js';
import {accountCodeHash} from './contract-pin.js';
import {keccak256} from './lib/keccak.js';
import {hex} from './test-wallet-core.js';
import {leftWord,word} from './lib/evmwots.js';
import {fromHex} from './local-proof.js';

const quantity=/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
const topic=name=>'0x'+hex(keccak256(new TextEncoder().encode(name)));
const rekeyed=topic('Rekeyed(uint32,bytes16,bytes16)');
const emptyHash='0x'+hex(keccak256(new Uint8Array()));
export const digestData=data=>data==='0x'?emptyHash:hashBytes(data);

// A node can expose a consumed nonce just before its transaction or receipt index catches up.
async function retryIndexRead(read) {
  try {return await read(true);} catch (error) {
    if (error.message!=='NET_INDEXING') throw error;
  }
  await new Promise(resolve=>setTimeout(resolve,300));
  try {return await read(false);} catch (error) {
    if (error.message==='NET_INDEXING') throw new Error('NET_UNVERIFIED',{cause:error});
    throw error;
  }
}
function valid(ok) { requireTrial(ok,'NET_UNVERIFIED'); }
function same(a,b) { return typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase(); }
function blockContains(block,hash) {
  valid(block && HASH.test(block.hash) && Array.isArray(block.transactions));
  return block.transactions.some(item=>same(item,hash));
}
function matchesAction(tx,row) {
  valid(quantity.test(tx.value) && typeof tx.input==='string' && /^0x(?:[0-9a-f]{2})*$/i.test(tx.input));
  const destination=row.kind==='create'?tx.to===null:same(tx.to,row.account);
  return destination && BigInt(tx.value)===BigInt(row.value) && tx.input.length<=96002 && digestData(tx.input)===row.dataHash;
}
function verifyEvents(receipt,row) {
  if (row.kind==='send') {
    const events=executionEvents(receipt,row.account);
    valid(events.length===1 && events[0].epoch===row.snapshot.epoch && events[0].leaf===row.intent.leaf &&
      events[0].digest==='0x'+row.intent.digest);
  } else if (row.kind==='create' || row.kind==='rotate') {
    const epoch=row.kind==='create'?1:row.snapshot.epoch+1;
    const data='0x'+hex(leftWord(fromHex(row.intent.newSeed)))+hex(leftWord(fromHex(row.intent.newRoot)));
    const logs=receipt.logs.filter(log=>same(log.address,row.account) && log.topics?.[0]===rekeyed);
    valid(logs.length===1 && !logs[0].removed && same(logs[0].transactionHash,receipt.transactionHash) &&
      same(logs[0].blockHash,receipt.blockHash) && logs[0].blockNumber===receipt.blockNumber &&
      logs[0].topics.length===2 && logs[0].topics[1]==='0x'+hex(word(epoch)) && logs[0].data===data);
  }
}

async function receiptHead(rpc,tag='latest') {
  const head=await rpc('eth_getBlockByNumber',[tag,false]);
  valid(head && quantity.test(head.number) && (tag==='latest' || head.number===tag) &&
    HASH.test(head.hash) && quantity.test(head.timestamp) && Math.abs(Date.now()/1000-Number(BigInt(head.timestamp)))<120);
  return head;
}
async function latestHead(rpc) {
  requireTrial(await rpc('eth_chainId')==='0x61','TRIAL_CHAIN');
  return receiptHead(rpc);
}

// The receipt readers have no signer, injected wallet or encrypted vault dependency.
export async function networkReceipt(endpoint,row,manualHash) {
  const rpc=accountRpc(endpoint,AbortSignal.timeout(45000));
  return retryIndexRead(async()=>observe(rpc,await latestHead(rpc),row,manualHash));
}
async function observe(rpc,head,row,manualHash) {
  const height=BigInt(head.number);
  const submittedHash=row.submittedHash??row.hash;
  const candidate=manualHash||row.hash;
  const prior=row.lastInclusion??(row.block && row.hash?{hash:row.hash,block:row.block}:undefined);
  const result={status:'unseen',hash:row.hash,submittedHash,lastInclusion:prior,replacementHash:null,
    moved:false,equivalent:false,block:null,gasUsed:null,feeWei:null,checkedBlock:head.number,checkedBlockHash:head.hash,
    replacementBlock:null,replacementBlockHash:null,reorgBlockHash:null};
  async function readBlock(number) {
    valid(quantity.test(number) && BigInt(number)<=height);
    const block=await rpc('eth_getBlockByNumber',[number,false]);
    valid(block?.number===number && HASH.test(block.hash));
    return block;
  }
  async function getTx(hash) {
    requireTrial(HASH.test(hash),'TRIAL_HASH');
    const tx=await rpc('eth_getTransactionByHash',[hash]);
    if (tx===null) return null;
    valid(same(tx.hash,hash) && tx.chainId==='0x61' && ADDRESS.test(tx.from) &&
      (tx.to===null || ADDRESS.test(tx.to)) && quantity.test(tx.nonce));
    requireTrial(same(tx.from,row.payer) && tx.nonce===row.nonce,'TRIAL_HASH');
    return tx;
  }
  async function isCanonical(tx) {
    if (!tx) return false;
    if (tx.blockNumber===null) { valid(tx.blockHash===null);return false; }
    valid(quantity.test(tx.blockNumber) && HASH.test(tx.blockHash));
    if (BigInt(tx.blockNumber)>height) return false;
    const block=await readBlock(tx.blockNumber);
    return same(block.hash,tx.blockHash) && blockContains(block,tx.hash);
  }
  const tx=candidate?await getTx(candidate):null;
  let mined=await isCanonical(tx)?tx:null;
  // A pasted replacement is evidence only when it consumes this payer nonce on the canonical chain.
  if (manualHash) requireTrial(tx && (mined || matchesAction(tx,row)),'TRIAL_HASH');
  if (!mined) {
    const count=await rpc('eth_getTransactionCount',[row.payer,head.number]);
    valid(quantity.test(count));
    if (BigInt(count)>BigInt(row.nonce)) {
      let hash=await findByNonce(rpc,row,height);
      // A fork may have included the nonce before the height saved in the original preview.
      if (!hash && row.startBlock!=='0x0') hash=await findByNonce(rpc,{...row,startBlock:'0x0'},height);
      requireTrial(hash!=null,'NET_INDEXING');
      valid(HASH.test(hash));
      mined=await getTx(hash);
      requireTrial(mined!==null,'NET_INDEXING');
      valid(await isCanonical(mined));
    }
  }
  if (mined) {
    const receipt=await rpc('eth_getTransactionReceipt',[mined.hash]);
    requireTrial(receipt!==null,'NET_INDEXING');
    valid(receipt && same(receipt.transactionHash,mined.hash) && same(receipt.blockHash,mined.blockHash) &&
      receipt.blockNumber===mined.blockNumber && same(receipt.from,mined.from) &&
      (mined.to===null?receipt.to===null:same(receipt.to,mined.to)) && ['0x0','0x1'].includes(receipt.status));
    if (!matchesAction(mined,row)) {
      result.status='replaced';result.replacementHash=mined.hash;
      result.replacementBlock=mined.blockNumber;result.replacementBlockHash=mined.blockHash;
    } else {
      const ok=receipt.status==='0x1';
      if (ok) {
        if (row.kind==='create') valid(same(receipt.contractAddress,row.wrapper));
        valid(Array.isArray(receipt.logs) && receipt.logs.length<=4096);
        verifyEvents(receipt,row);
        valid(hashBytes(await rpc('eth_getCode',[row.account,head.number]))===accountCodeHash);
      }
      if (!ok) valid(Array.isArray(receipt.logs) && receipt.logs.length===0);
      valid(quantity.test(receipt.gasUsed) && quantity.test(receipt.effectiveGasPrice));
      result.status=ok?'included':'reverted';
      result.hash=mined.hash;
      result.equivalent=!!submittedHash && !same(submittedHash,mined.hash);
      result.moved=!!prior && same(prior.hash,mined.hash) &&
        (prior.block!==mined.blockNumber || (!!prior.blockHash && !same(prior.blockHash,mined.blockHash)) || !!row.moved);
      result.block=mined.blockNumber;
      result.lastInclusion={hash:mined.hash,block:mined.blockNumber,blockHash:mined.blockHash};
      result.gasUsed=BigInt(receipt.gasUsed).toString();
      result.feeWei=(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)).toString();
    }
  } else if (prior) {
    const block=await readBlock(prior.block);
    // An unavailable receipt or lagging node alone cannot prove a reorganization.
    valid((prior.blockHash && !same(prior.blockHash,block.hash)) || !blockContains(block,prior.hash));
    result.status='reorg';result.reorgBlockHash=block.hash;
  } else if (tx?.blockNumber && BigInt(tx.blockNumber)>height) {
    result.status='waiting';
  } else if (row.kind!=='fund' && BigInt(head.timestamp)>BigInt(row.deadline)) {
    result.status='expired';
  } else if (tx?.blockNumber===null && matchesAction(tx,row)) {
    result.status='pending';result.hash=tx.hash;
  }
  const anchor=await readBlock(head.number);
  valid(same(anchor.hash,head.hash));
  return result;
}

// Pin both reads to the same height, even if one provider is already a few blocks ahead.
export async function compareNetworkReceipts(primary,secondary,row,manualHash) {
  requireTrial(new URL(primary).origin!==new URL(secondary).origin,'NET_SOURCES');
  if (manualHash) requireTrial(HASH.test(manualHash),'TRIAL_HASH');
  const signal=AbortSignal.timeout(45000);
  const clients=[accountRpc(primary,signal),accountRpc(secondary,signal)];
  return retryIndexRead(first=>compareAtCommonHead(clients,row,manualHash,first));
}
async function compareAtCommonHead(clients,row,manualHash,first) {
  const heads=await Promise.allSettled(clients.map(latestHead));
  const ready=heads.map(entry=>entry.status==='fulfilled'?entry.value:null);
  if (ready[0] && ready[1]) {
    const lower=BigInt(ready[0].number)<=BigInt(ready[1].number)?0:1;
    const higher=1-lower, block=ready[lower].number;
    if (ready[higher].number!==block) {
      try {ready[higher]=await receiptHead(clients[higher],block);} catch {ready[higher]=null;}
    }
    if (ready[higher] && (!same(ready[0].hash,ready[1].hash) || BigInt(ready[0].timestamp)!==BigInt(ready[1].timestamp))) {
      return {check:{kind:'conflict',reason:'block',block}};
    }
  }
  const reads=await Promise.allSettled(clients.map((rpc,i)=>ready[i]?observe(rpc,ready[i],row,manualHash):null));
  if (first && reads.some(entry=>entry.reason?.message==='NET_INDEXING')) throw new Error('NET_INDEXING');
  const [a,b]=reads.map(entry=>entry.status==='fulfilled'?entry.value:null);
  if (a && b) {
    const fields=['status','hash','checkedBlock','checkedBlockHash','block','gasUsed','feeWei','replacementHash',
      'replacementBlock','replacementBlockHash','reorgBlockHash'];
    const equal=(left,right)=>left===right || same(left,right);
    const agree=fields.every(key=>equal(a[key],b[key])) && equal(a.lastInclusion?.blockHash,b.lastInclusion?.blockHash);
    if (!agree) return {check:{kind:'conflict',reason:'observation',block:a.checkedBlock,primary:a.status,secondary:b.status}};
    return {check:{kind:'agreed',block:a.checkedBlock},observation:a};
  }
  const single=a??b;
  if (single) return {check:{kind:'single',source:a?'primary':'secondary',block:single.checkedBlock,status:single.status}};
  if (manualHash && reads.every(entry=>entry.reason?.message==='TRIAL_HASH')) throw new Error('TRIAL_HASH');
  return {check:{kind:'unavailable'}};
}
