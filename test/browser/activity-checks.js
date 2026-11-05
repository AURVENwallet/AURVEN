// Copy this harness into ignored ui/demo/ and serve ui/ on loopback.
import {openActivityStore,associate,addHash,beginCheck,finishCheck,MAX_ACCOUNTS} from '../activity-store.js';
import {accountCodeHash} from '../contract-pin.js';
const output=document.querySelector('#results'),button=document.querySelector('#run');
const assert=(value,message)=>{if(!value)throw new Error(message);};
button.onclick=async()=>{
  const name='aurven-activity-check-'+crypto.randomUUID(),stores=[];button.disabled=true;output.textContent='Running…\n';
  const open=async()=>{const store=await openActivityStore(name);stores.push(store);return store;};
  const report=text=>{output.textContent+='PASS '+text+'\n';};
  const state={account:'0x'+'11'.repeat(20),chainId:31337,codeHash:accountCodeHash,epoch:1,next:0,root:'0x'+'22'.repeat(16),pubSeed:'0x'+'33'.repeat(16),blockNumber:'0x1',blockHash:'0x'+'44'.repeat(32)};
  const hash='0x'+'55'.repeat(32),key='31337:'+state.account;
  try{
    const a=await open();await a.update(key,old=>addHash(associate(state,old),hash));a.close();
    const b=await open();assert((await b.list())[0].transactions[0].hash===hash,'Record lost on reopen');report('Account and transaction survive close/reopen');
    const c=await open();await Promise.all([b.update(key,old=>beginCheck(old,hash,'old')),c.update(key,old=>beginCheck(old,hash,'new'))]);
    await c.update(key,old=>finishCheck(old,hash,'new',{status:'pending'}));await b.update(key,old=>finishCheck(old,hash,'old',{status:'error'}));
    assert((await b.list())[0].transactions[0].status==='pending','Stale request overwrote new result');report('Two connections serialize writes and reject stale results');
    try{await b.update(key,()=>{throw new Error('intentional');});throw new Error('Expected abort');}catch(error){assert(error.message==='intentional','Unexpected error');}
    assert((await b.list())[0].transactions[0].status==='pending','Abort changed record');report('Aborted write leaves existing record intact');
    for(let i=2;i<=MAX_ACCOUNTS;i++){const s={...state,account:'0x'+i.toString(16).padStart(40,'0')};await b.update('31337:'+s.account,old=>associate(s,old));}
    try{const s={...state,account:'0x'+'ff'.repeat(20)};await c.update('31337:'+s.account,old=>associate(s,old));throw new Error('Expected limit');}catch(error){assert(error.message==='LIMIT','Wrong limit error');}
    assert((await b.list()).length===MAX_ACCOUNTS,'Account limit changed');report('Account limit enforced atomically');
    output.textContent+='ALL 4 CHECKS PASSED\n';
  }catch(error){output.textContent+='FAIL '+error.message+'\n';}
  finally{stores.forEach(store=>store.close());const request=indexedDB.deleteDatabase(name);await new Promise(resolve=>{request.onsuccess=request.onerror=request.onblocked=resolve;});button.disabled=false;}
};
