import {fail} from './vault-crypto.js';
import {accountCodeHash} from './contract-pin.js';

const address=/^0x[0-9a-f]{40}$/;
const value16=/^0x[0-9a-f]{32}$/;
export function validateKeySnapshot(value,chainId,account){
  if(!value||![97,31337].includes(chainId)||!address.test(account)||
    value.chainId!==chainId||value.account?.toLowerCase()!==account||value.codeHash!==accountCodeHash||
    !Number.isInteger(value.epoch)||value.epoch<0||value.epoch>4294967295||
    !Number.isInteger(value.next)||value.next<0||value.next>1024||
    !value16.test(value.pubSeed)||!value16.test(value.root)||
    !/^0x[0-9a-f]{1,64}$/.test(value.blockNumber)||!/^0x[0-9a-f]{64}$/.test(value.blockHash)||
    !Number.isSafeInteger(value.timestamp)||Math.abs(Date.now()/1000-value.timestamp)>120)fail('KEY_CONTEXT');
  return {account,chainId,epoch:value.epoch,next:value.next,pubSeed:value.pubSeed,root:value.root,
    blockNumber:value.blockNumber,blockHash:value.blockHash,timestamp:value.timestamp,codeHash:value.codeHash};
}
export function keyStateEqual(before,after){
  return ['account','chainId','epoch','next','pubSeed','root','codeHash'].every(field=>before[field]===after[field]);
}
export function validateDerivedRoot(value,record,snapshot){
  const fields=['walletId','chainId','account','epoch','pubSeed','root'];
  if(!value||Object.keys(value).sort().join('|')!==fields.sort().join('|')||
    value.walletId!==record.walletId||value.chainId!==record.chainId||value.account!==snapshot.account||
    value.epoch!==snapshot.epoch||!value16.test(value.pubSeed)||!value16.test(value.root))fail('KEY_CONTEXT');
  // An active tree must be derived with the exact public seed supplied by the account.
  if(snapshot.epoch>0&&value.pubSeed!==snapshot.pubSeed)fail('KEY_CONTEXT');
  return value;
}
