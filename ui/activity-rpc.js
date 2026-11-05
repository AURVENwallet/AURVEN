import {rpcEndpoint} from './account-state.js';
import {keccak256} from './lib/keccak.js';

export const HASH = /^0x[0-9a-f]{64}$/i;
export const ADDRESS = /^0x[0-9a-f]{40}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/i;
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const fail = code => { throw new Error(code); };
const valid = (condition,code='INVALID_RESPONSE') => {if(!condition)fail(code);};
const executedTopic='0x'+Array.from(keccak256(new TextEncoder().encode('Executed(uint32,uint32,bytes16)')),b=>b.toString(16).padStart(2,'0')).join('');

async function boundedJson(response){
  valid(response.ok && response.body,'RPC_UNAVAILABLE');
  const reader=response.body.getReader();const chunks=[];let size=0;
  try{
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;
      valid(size<=1048576,'RESPONSE_TOO_LARGE');chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
function blockValid(block){
  valid(block && QUANTITY.test(block.number) && HASH.test(block.hash) && QUANTITY.test(block.timestamp));
  return block;
}
function executionEvents(receipt,account){
  valid(Array.isArray(receipt.logs)&&receipt.logs.length<=4096);
  const result=[];
  for(const log of receipt.logs){
    if(!same(log.address,account)||!same(log.topics?.[0],executedTopic))continue;
    valid(log.removed!==true && same(log.transactionHash,receipt.transactionHash) &&
      same(log.blockHash,receipt.blockHash) && log.blockNumber===receipt.blockNumber &&
      log.topics.length===2 && /^0x0{56}[0-9a-f]{8}$/i.test(log.topics[1]) &&
      /^0x0{56}[0-9a-f]{8}[0-9a-f]{32}0{32}$/i.test(log.data));
    const leaf=Number(BigInt('0x'+log.data.slice(2,66)));
    valid(leaf<1024);
    result.push({epoch:Number(BigInt(log.topics[1])),leaf,digest:'0x'+log.data.slice(66,98).toLowerCase()});
    valid(result.length<=64);
  }
  return result;
}

// Observation only: this module neither signs nor sends transactions, and has no vault access.
export async function checkTransaction({endpoint,chainId,account,hash,previous=null,signal}){
  valid([97,31337].includes(chainId),'NETWORK');valid(ADDRESS.test(account)&&HASH.test(hash),'INPUT');
  const url=rpcEndpoint(endpoint);let id=0;
  async function rpc(method,params=[]){
    const requestId=++id;
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}),credentials:'omit',redirect:'error',
      signal:AbortSignal.any([AbortSignal.timeout(12000),...(signal?[signal]:[])])});
    const data=await boundedJson(response);
    valid(data?.jsonrpc==='2.0'&&data.id===requestId&&!data.error&&data.result!==undefined);
    return data.result;
  }
  valid(await rpc('eth_chainId')==='0x'+chainId.toString(16),'NETWORK');
  const head=blockValid(await rpc('eth_getBlockByNumber',['latest',false]));
  const timestamp=Number(BigInt(head.timestamp));
  valid(Number.isSafeInteger(timestamp)&&Math.abs(Date.now()/1000-timestamp)<=120,'STALE_NODE');
  const [tx,receipt]=await Promise.all([rpc('eth_getTransactionByHash',[hash]),rpc('eth_getTransactionReceipt',[hash])]);
  const observed={headNumber:head.number,headHash:head.hash};
  async function stableHead(){
    const current=blockValid(await rpc('eth_getBlockByNumber',[head.number,false]));
    valid(current.number===head.number && same(current.hash,head.hash),'CHANGED_DURING_READ');
  }
  if(tx===null && receipt===null){await stableHead();return {...observed,status:previous?'unavailable':'unknown'};}
  valid(tx && same(tx.hash,hash) && ADDRESS.test(tx.from) &&
    (tx.to===null||ADDRESS.test(tx.to)) && (tx.chainId===undefined||tx.chainId==='0x'+chainId.toString(16)));
  valid(tx.to===null||same(tx.to,account),'ACCOUNT_MISMATCH');
  if(receipt===null){
    valid(tx.to!==null,'ACCOUNT_UNVERIFIED');
    if(tx.blockNumber===null && tx.blockHash===null){await stableHead();return {...observed,status:previous?'unavailable':'pending'};}
    valid(QUANTITY.test(tx.blockNumber)&&HASH.test(tx.blockHash));
    await stableHead();return {...observed,status:'unavailable'};
  }
  valid(receipt && same(receipt.transactionHash,hash) && same(receipt.from,tx.from) &&
    (tx.to===null?receipt.to===null:same(receipt.to,tx.to)) &&
    QUANTITY.test(receipt.blockNumber)&&HASH.test(receipt.blockHash)&&
    tx.blockNumber===receipt.blockNumber&&same(tx.blockHash,receipt.blockHash)&&
    (receipt.status==='0x0'||receipt.status==='0x1')&&
    QUANTITY.test(receipt.gasUsed)&&QUANTITY.test(receipt.effectiveGasPrice));
  valid(tx.to!==null||same(receipt.contractAddress,account),'ACCOUNT_MISMATCH');
  const height=BigInt(receipt.blockNumber);valid(height<=BigInt(head.number));
  const canonical=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  if(canonical===null || !same(blockValid(canonical).hash,receipt.blockHash)){
    await stableHead();return {...observed,status:'reorg'};
  }
  valid(canonical.number===receipt.blockNumber && Array.isArray(canonical.transactions)&&
    canonical.transactions.some(value=>same(value,hash)),'NOT_IN_BLOCK');
  const executions=executionEvents(receipt,account);
  valid(receipt.status==='0x1'||executions.length===0);
  await stableHead();
  const again=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  valid(again && same(blockValid(again).hash,receipt.blockHash) && again.number===receipt.blockNumber,'CHANGED_DURING_READ');
  return {...observed,status:receipt.status==='0x1'?'included':'reverted',
    inclusion:{blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,
      confirmations:(BigInt(head.number)-height+1n).toString(),
      feeWei:(BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice)).toString(),executions},
    relocated:!!previous&&!same(previous.blockHash,receipt.blockHash)};
}
