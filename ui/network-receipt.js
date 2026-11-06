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

// Reconcile public evidence only. This reader has no signer, injected wallet or vault-store dependency.
export async function networkReceipt(endpoint,row,manualHash) {
  const rpc=accountRpc(endpoint,AbortSignal.timeout(45000));
  requireTrial(await rpc('eth_chainId')==='0x61','TRIAL_CHAIN');
  const head=await rpc('eth_getBlockByNumber',['latest',false]);
  valid(head && quantity.test(head.number) && HASH.test(head.hash) && quantity.test(head.timestamp) &&
    Math.abs(Date.now()/1000-Number(BigInt(head.timestamp)))<120);
  const height=BigInt(head.number);
  const submittedHash=row.submittedHash??row.hash;
  const candidate=manualHash||row.hash;
  const prior=row.lastInclusion??(row.block && row.hash?{hash:row.hash,block:row.block}:undefined);
  const result={status:'unseen',hash:row.hash,submittedHash,lastInclusion:prior,replacementHash:null,
    moved:false,equivalent:false,block:null,gasUsed:null,feeWei:null,checkedBlock:head.number};
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
    valid(HASH.test(tx.blockHash));
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
      valid(HASH.test(hash));
      mined=await getTx(hash);
      valid(await isCanonical(mined));
    }
  }
  if (mined) {
    const receipt=await rpc('eth_getTransactionReceipt',[mined.hash]);
    valid(receipt && same(receipt.transactionHash,mined.hash) && same(receipt.blockHash,mined.blockHash) &&
      receipt.blockNumber===mined.blockNumber && same(receipt.from,mined.from) &&
      (mined.to===null?receipt.to===null:same(receipt.to,mined.to)) && ['0x0','0x1'].includes(receipt.status));
    if (!matchesAction(mined,row)) {
      result.status='replaced';result.replacementHash=mined.hash;
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
    result.status='reorg';
  } else if (row.kind!=='fund' && BigInt(head.timestamp)>BigInt(row.deadline)) {
    result.status='expired';
  } else if (tx?.blockNumber===null && matchesAction(tx,row)) {
    result.status='pending';result.hash=tx.hash;
  }
  const anchor=await readBlock(head.number);
  valid(same(anchor.hash,head.hash));
  return result;
}
