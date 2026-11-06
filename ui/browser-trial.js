import {ADDRESS,HASH,checkTransaction,executionEvents} from './activity-rpc.js';
import {keccak256} from './lib/keccak.js';
import {addressBytes,addressWord,concat,word} from './lib/evmwots.js';
import {hex} from './test-wallet-core.js';
import {accountCodeHash} from './contract-pin.js';

export const trialEndpoint='https://bsc-testnet.bnbchain.org';
const gasLimit=3000000n;
const completedTopic='0x'+hex(keccak256(new TextEncoder().encode('TrialCompleted(address,address,address)')));
const topicAddress=address=>'0x'+hex(addressWord(address));
export const q=n=>'0x'+BigInt(n).toString(16);
export function requireTrial(ok,code) {if (!ok) throw new Error(code);}
export function hashBytes(value) {
  requireTrial(typeof value==='string' && /^0x(?:[0-9a-f]{2}){1,48000}$/i.test(value),'TRIAL_DATA');
  return '0x'+hex(keccak256(Uint8Array.from(value.slice(2).match(/../g),pair=>parseInt(pair,16))));
}
export function createdAddress(payer,nonce) {
  const n=BigInt(nonce);
  requireTrial(n>=0n && n<1n<<64n,'TRIAL_NONCE');
  const bytes=word(n).slice(24), start=bytes.findIndex(b=>b!==0), trimmed=start===-1?new Uint8Array():bytes.slice(start);
  const encoded=n>0n && n<128n?trimmed:concat(Uint8Array.of(0x80+trimmed.length),trimmed);
  return '0x'+hex(keccak256(concat(Uint8Array.of(0xc0+21+encoded.length,0x94),addressBytes(payer),encoded)).slice(12));
}
export async function payerAccount(provider,interactive=false) {
  requireTrial(typeof provider?.request==='function','TRIAL_PROVIDER');
  requireTrial(await provider.request({method:'eth_chainId'})==='0x61','TRIAL_CHAIN');
  const accounts=await provider.request({method:interactive?'eth_requestAccounts':'eth_accounts'});
  requireTrial(Array.isArray(accounts) && ADDRESS.test(accounts[0]),'TRIAL_PAYER');
  return accounts[0].toLowerCase();
}
export async function previewTrial(rpc,payer,recipient) {
  requireTrial(ADDRESS.test(payer) && ADDRESS.test(recipient) && BigInt(recipient)>0xffffn,'TRIAL_RECIPIENT');
  requireTrial(await rpc('eth_chainId')==='0x61','TRIAL_CHAIN');
  const [nonce,pending,head,price,balance,payerCode,recipientCode]=await Promise.all([
    rpc('eth_getTransactionCount',[payer,'latest']),rpc('eth_getTransactionCount',[payer,'pending']),
    rpc('eth_getBlockByNumber',['latest',false]),rpc('eth_gasPrice'),rpc('eth_getBalance',[payer,'latest']),
    rpc('eth_getCode',[payer,'latest']),rpc('eth_getCode',[recipient,'latest'])
  ]);
  requireTrial(nonce===pending,'TRIAL_NONCE');
  requireTrial(payerCode==='0x' && recipientCode==='0x','TRIAL_RECIPIENT');
  requireTrial(BigInt(price)>0n && BigInt(price)<=5000000000n,'TRIAL_PRICE');
  requireTrial(BigInt(balance)>=BigInt(price)*gasLimit+1n,'TRIAL_BALANCE');
  const now=Number(BigInt(head.timestamp));
  requireTrial(Number.isSafeInteger(now) && Math.abs(Date.now()/1000-now)<120,'TRIAL_CLOCK');
  const wrapper=createdAddress(payer,nonce),account=createdAddress(wrapper,1);
  requireTrial(![wrapper,account].includes(recipient.toLowerCase()),'TRIAL_RECIPIENT');
  return {id:crypto.randomUUID(),payer:payer.toLowerCase(),recipient:recipient.toLowerCase(),nonce,wrapper,account,
    startBlock:head.number,deadline:now+1800,gas:q(gasLimit),gasPrice:price};
}
export async function checkBeforeSend(rpc,provider,plan) {
  requireTrial(await payerAccount(provider)===plan.payer,'TRIAL_PAYER');
  requireTrial(await rpc('eth_chainId')==='0x61','TRIAL_CHAIN');
  const [pending,head,balance]=await Promise.all([rpc('eth_getTransactionCount',[plan.payer,'pending']),
    rpc('eth_getBlockByNumber',['latest',false]),rpc('eth_getBalance',[plan.payer,'latest'])]);
  requireTrial(pending===plan.nonce,'TRIAL_NONCE');
  const now=Number(BigInt(head.timestamp));
  requireTrial(Math.abs(Date.now()/1000-now)<120 && now+30<plan.deadline,'TRIAL_CLOCK');
  requireTrial(BigInt(balance)>=BigInt(plan.gas)*BigInt(plan.gasPrice)+1n,'TRIAL_BALANCE');
}

async function findByNonce(rpc,row,head) {
  let low=BigInt(row.startBlock),high=head;
  const nonce=BigInt(row.nonce);
  const count=async height=>BigInt(await rpc('eth_getTransactionCount',[row.payer,q(height)]));
  if (await count(high)<=nonce) return null;
  while (low<high) {
    const middle=(low+high)>>1n;
    if (await count(middle)>nonce) high=middle;else low=middle+1n;
  }
  const block=await rpc('eth_getBlockByNumber',[q(low),true]);
  return block?.transactions?.find(tx=>tx.from?.toLowerCase()===row.payer && tx.nonce===row.nonce)?.hash;
}

export async function recoverTrial(endpoint,rpc,row,manualHash) {
  requireTrial(await rpc('eth_chainId')==='0x61','TRIAL_CHAIN');
  let hash=manualHash || row.hash;
  const topics=[completedTopic,topicAddress(row.account),topicAddress(row.payer),topicAddress(row.recipient)];
  if (!hash) {
    // Only this sender and nonce can create the recorded wrapper. Limit each query on public RPCs.
    const head=BigInt(await rpc('eth_blockNumber')), from=BigInt(row.cursor??row.startBlock);
    if (from>head) return {status:'waiting'};
    const end=from+999n<head?from+999n:head;
    let logs;
    try {logs=await rpc('eth_getLogs',[{address:row.wrapper,topics,fromBlock:q(from),toBlock:q(end)}]);}
    catch { /* Some public BSC nodes disable filtered logs. Look up the mined payer nonce below. */ }
    if (logs!==undefined) requireTrial(Array.isArray(logs) && logs.length<=1,'TRIAL_RECEIPT');
    hash=logs?.[0]?.transactionHash;
    if (!hash) {
      try {hash=await findByNonce(rpc,row,head);}
      catch {if (!logs) throw new Error('TRIAL_LOOKUP');}
    }
    if (!hash) return {status:'waiting',cursor:q(end===head?(end>12n?end-12n:0n):end+1n)};
  }
  requireTrial(HASH.test(hash),'TRIAL_HASH');
  const tx=await rpc('eth_getTransactionByHash',[hash]);
  if (!tx) return {status:'waiting'};
  requireTrial(tx.from?.toLowerCase()===row.payer && tx.to===null && tx.nonce===row.nonce &&
    tx.chainId==='0x61' && BigInt(tx.value)===1n && hashBytes(tx.input)===row.dataHash,'TRIAL_HASH');
  if (tx.blockHash===null) return {status:'waiting',hash};
  const receipt=await rpc('eth_getTransactionReceipt',[hash]);
  if (!receipt) return {status:'waiting',hash};
  // Failed creations can have a null contractAddress on some clients.
  if (receipt.status==='0x0') {
    const block=await rpc('eth_getBlockByNumber',[tx.blockNumber,false]);
    requireTrial(block?.hash===tx.blockHash && receipt.blockHash===block.hash && receipt.transactionHash===hash &&
      block.transactions.includes(hash),'TRIAL_RECEIPT');
    return {status:'reverted',hash};
  }
  const seen=await checkTransaction({endpoint,chainId:97,account:row.wrapper,hash});
  if (seen.status!=='included') return {status:'waiting',hash};
  requireTrial(receipt.blockHash===seen.inclusion.blockHash && receipt.logs.some(log=>!log.removed &&
    log.address?.toLowerCase()===row.wrapper && log.transactionHash===hash && log.blockHash===receipt.blockHash &&
    log.topics?.length===4 && topics.every((topic,i)=>topic===log.topics[i]?.toLowerCase())),'TRIAL_RECEIPT');
  const events=executionEvents(receipt,row.account);
  requireTrial(events.length===1 && events[0].epoch===1 && events[0].leaf===0 && events[0].digest===row.digest,'TRIAL_RECEIPT');
  requireTrial(hashBytes(await rpc('eth_getCode',[row.account,'latest']))===accountCodeHash,'TRIAL_RECEIPT');
  const canonical=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
  requireTrial(canonical?.hash===receipt.blockHash,'TRIAL_RECEIPT');
  return {status:'included',hash,block:receipt.blockNumber,gasUsed:BigInt(receipt.gasUsed).toString(),feeWei:seen.inclusion.feeWei};
}
