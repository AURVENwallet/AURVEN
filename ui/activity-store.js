import {ADDRESS,HASH} from './activity-rpc.js';
import {accountCodeHash} from './contract-pin.js';

export const ACTIVITY_DB='aurven-readonly-activity-v1';
export const MAX_ACCOUNTS=8, MAX_TRANSACTIONS=96;
const fail=code=>{throw new Error(code);};
export function accountKey(chainId,account){
  if(![97,31337].includes(chainId)||!ADDRESS.test(account))fail('INPUT');
  return chainId+':'+account.toLowerCase();
}
export function associate(state,old=null){
  const key=accountKey(state.chainId,state.account);
  if(state.codeHash!==accountCodeHash||!HASH.test(state.blockHash)||
    !/^0x[0-9a-f]+$/i.test(state.blockNumber)||!Number.isInteger(state.epoch)||state.epoch<0||state.epoch>4294967295||
    !Number.isInteger(state.next)||state.next<0||state.next>1024||
    !/^0x[0-9a-f]{32}$/i.test(state.root)||!/^0x[0-9a-f]{32}$/i.test(state.pubSeed))fail('INPUT');
  if(old&&old.key!==key)fail('INPUT');
  // Explicit allowlist: never retain endpoint URLs, credentials or a vault seed.
  return {key,chainId:state.chainId,account:state.account.toLowerCase(),associatedAt:old?.associatedAt??Date.now(),
    snapshot:{epoch:state.epoch,next:state.next,root:state.root,pubSeed:state.pubSeed,
      blockNumber:state.blockNumber,blockHash:state.blockHash,checkedAt:Date.now()},transactions:old?.transactions??[]};
}
export function addHash(record,hash){
  if(!record||!HASH.test(hash))fail('INPUT');hash=hash.toLowerCase();
  if(record.transactions.some(row=>row.hash===hash))return record;
  if(record.transactions.length>=MAX_TRANSACTIONS)fail('LIMIT');
  return {...record,transactions:[{hash,addedAt:Date.now(),status:'unchecked',checkedAt:null,token:null,result:null,previous:null},...record.transactions]};
}
export function beginCheck(record,hash,token){
  if(!record||!record.transactions.some(row=>row.hash===hash)||typeof token!=='string'||!token)fail('INPUT');
  return {...record,transactions:record.transactions.map(row=>row.hash===hash?{...row,status:'checking',token}:row)};
}
export function finishCheck(record,hash,token,result){
  if(!['included','reverted','pending','unknown','unavailable','reorg','error'].includes(result?.status))fail('INPUT');
  return {...record,transactions:record.transactions.map(row=>row.hash===hash&&row.token===token?
    {...row,status:result.status,token:null,checkedAt:Date.now(),result,previous:result.inclusion??row.previous}:row)};
}
export function publicReport(records){
  return {format:'aurven-readonly-activity-v1',exportedAt:new Date().toISOString(),ownershipVerified:false,
    note:'Cached observations from a single RPC. Not finality, key ownership or a signing journal. Never reuse a signing leaf based on transaction status.',
    accounts:records.map(({chainId,account,associatedAt,snapshot,transactions})=>({chainId,account,associatedAt,snapshot,
      transactions:transactions.map(({hash,addedAt,status,checkedAt,result,previous})=>({hash,addedAt,status:status==='checking'?'unchecked':status,checkedAt,result,previous}))}))};
}

export async function openActivityStore(name=ACTIVITY_DB){
  if(!globalThis.indexedDB||!/^[a-z0-9-]{1,100}$/.test(name))fail('STORAGE');
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open(name,1);let blocked=false;
    request.onupgradeneeded=()=>request.result.createObjectStore('accounts',{keyPath:'key'});
    request.onblocked=()=>{blocked=true;reject(new Error('STORAGE'));};request.onerror=()=>reject(new Error('STORAGE'));
    request.onsuccess=()=>{if(blocked)request.result.close();else resolve(request.result);};
  });
  db.onversionchange=()=>db.close();
  function run(mode,operation){return new Promise((resolve,reject)=>{
    let tx,result,problem;
    try{
      tx=db.transaction('accounts',mode,mode==='readwrite'?{durability:'strict'}:undefined);
      tx.oncomplete=()=>resolve(result);tx.onerror=()=>{};tx.onabort=()=>reject(problem??new Error('STORAGE'));
      const abort=error=>{problem=error;tx.abort();};
      operation(tx.objectStore('accounts'),value=>{result=value;},abort);
    }catch(error){problem=error;if(tx){try{tx.abort();}catch{reject(error);}}else reject(error);}
  });}
  return {
    list:()=>run('readonly',(store,done)=>{const request=store.getAll();request.onsuccess=()=>done(request.result);}),
    update:(key,mutate)=>run('readwrite',(store,done,abort)=>{
      const request=store.get(key);
      request.onsuccess=()=>{
        try{
          const next=mutate(request.result??null);if(!next||next.key!==key)fail('INPUT');
          const write=()=>{store.put(next);done(next);};
          if(request.result)write();else{const count=store.count();count.onsuccess=()=>{
            if(count.result>=MAX_ACCOUNTS)abort(new Error('LIMIT'));else write();};}
        }catch(error){abort(error);}
      };
    }),close:()=>db.close()
  };
}
