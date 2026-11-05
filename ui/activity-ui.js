import {openActivityStore,associate,accountKey,addHash,beginCheck,finishCheck,publicReport} from './activity-store.js';
import {checkTransaction} from './activity-rpc.js';

const get=id=>document.getElementById(id);
const copy={unchecked:'等待核对',checking:'核对中断或进行中',included:'已上链 · 执行成功',reverted:'已上链 · 执行回滚',
  pending:'等待打包',unknown:'暂时查不到',unavailable:'回执暂不可确认',reorg:'区块归属已变化',error:'核对失败'};
const errors={NETWORK:'RPC 网络不匹配',ACCOUNT_MISMATCH:'交易不属于所选账户',ACCOUNT_UNVERIFIED:'创建交易尚不能确认账户地址',
  STALE_NODE:'节点时间过旧或本机时间不准',CHANGED_DURING_READ:'核对期间区块发生变化',NOT_IN_BLOCK:'区块中未找到该交易',
  LIMIT:'本地记录已达到上限',INPUT:'地址或交易哈希格式无效',STORAGE:'本地记录存储不可用',CANCELED:'本次核对已取消'};
const message=error=>errors[error?.message]??'暂时无法核对，请检查 RPC 后重试。';
let store,records=[],selected='',controller,busy=false;
const endpoints=new Map(); // Session memory only; RPC URLs can contain provider credentials.
const ready=openActivityStore().then(value=>{store=value;return refresh();}).catch(()=>{
  get('activityStatus').textContent=errors.STORAGE;get('activityControls').disabled=true;
});
const row=()=>records.find(record=>record.key===selected);
function node(tag,text,className){const element=document.createElement(tag);element.textContent=text;if(className)element.className=className;return element;}
function short(value){return value.slice(0,10)+'…'+value.slice(-8);}
function render(){
  const record=row();
  get('activityEmpty').hidden=!!record;
  get('activityAccount').textContent=record?.account??'—';
  get('activityCount').textContent=String(record?.transactions.length??0).padStart(2,'0');
  get('activityCheck').disabled=!record||!record.transactions.length||busy;
  get('activityAdd').disabled=!record||busy;get('activityUse').disabled=!record||busy;
  get('activityExport').disabled=!records.length;get('activityCancel').hidden=!busy;
  get('activitySelect').disabled=busy||!records.length;get('activityRpc').disabled=busy;
  get('activityRows').replaceChildren(...(record?.transactions??[]).map(tx=>{
    const item=document.createElement('li');item.className='activity-record';
    const header=document.createElement('div');header.className='activity-record-top';
    header.append(node('strong',copy[tx.status]??copy.unchecked,'activity-state state-'+tx.status),
      node('span',tx.checkedAt?'上次核对':'尚未核对','activity-cached'));
    const hash=node('code',tx.hash);hash.setAttribute('data-i18n-ignore','');
    item.append(header,hash);
    if(tx.checkedAt){const time=node('time',new Date(tx.checkedAt).toLocaleString());time.dateTime=new Date(tx.checkedAt).toISOString();item.append(time);}
    const inclusion=tx.result?.inclusion;
    if(inclusion&&['included','reverted'].includes(tx.status)){
      const details=node('div','','activity-metrics');
      for(const [label,value] of [['区块',BigInt(inclusion.blockNumber).toString()],['区块确认数',inclusion.confirmations],['费用（wei）',inclusion.feeWei]]){
        const metric=document.createElement('div');metric.append(node('span',label),node('b',value));details.append(metric);
      }
      item.append(details);
      for(const event of inclusion.executions){const line=node('p','','activity-leaf');
        line.append(node('span','链上执行记录'),document.createTextNode(' · '),node('span','代数'),document.createTextNode(' '+event.epoch+' · '),
          node('span','叶号'),document.createTextNode(' '+event.leaf));item.append(line);}
      if(tx.result.relocated)item.append(node('p','该交易重新出现在不同区块。','activity-warning'));
    }else if(tx.previous){const previous=node('p','','activity-warning');previous.append(node('span','此前所在区块（当前未确认）'),document.createTextNode(' '+BigInt(tx.previous.blockNumber)));item.append(previous);}
    if(tx.result?.error)item.append(node('p',errors[tx.result.error]??'暂时无法核对，请检查 RPC 后重试。','activity-warning'));
    return item;
  }));
}
async function refresh(){
  records=await store.list();if(!records.some(record=>record.key===selected))selected=records[0]?.key??'';
  get('activitySelect').replaceChildren(...records.map(record=>{const option=node('option',(record.chainId===97?'BSC Testnet':'Anvil')+' · '+short(record.account));option.value=record.key;return option;}));
  get('activitySelect').value=selected;render();
}
function selectEndpoint(){get('activityRpc').value=endpoints.get(selected)??(row()?.chainId===31337?'http://127.0.0.1:8950':'');}
await ready;selectEndpoint();

export async function trackAccount(state,endpoint,hashes=[]){
  await ready;if(!store)throw new Error('STORAGE');
  controller?.abort();
  const key=accountKey(state.chainId,state.account);
  await store.update(key,old=>{let next=associate(state,old);for(const hash of hashes)next=addHash(next,hash);return next;});
  endpoints.set(key,endpoint);selected=key;await refresh();selectEndpoint();
  get('activityStatus').textContent='已保存只读账户关联。选择核对交易以获取当前结果。';
  location.hash='activity';
}
get('activitySelect').onchange=()=>{controller?.abort();selected=get('activitySelect').value;selectEndpoint();render();
  get('activityStatus').textContent='显示本机保存的记录。核对前请确认 RPC 网络。';};
get('activityRpc').oninput=()=>{endpoints.set(selected,get('activityRpc').value.trim());};
get('activityForm').onsubmit=async event=>{
  event.preventDefault();if(!row()||busy||!store)return;
  try{await store.update(selected,old=>addHash(old,get('activityHash').value.trim()));get('activityHash').value='';await refresh();
    get('activityStatus').textContent='交易哈希已保存，尚未核对。';
  }catch(error){get('activityStatus').textContent=message(error);}
};
get('activityUse').onclick=()=>{
  if(!row())return;
  document.dispatchEvent(new CustomEvent('aurven:watch-account',{detail:{account:row().account,chainId:row().chainId,endpoint:get('activityRpc').value.trim()}}));
  location.hash='wallet';
};
get('activityCancel').onclick=()=>{controller?.abort();};
get('activityCheck').onclick=async()=>{
  const record=row();if(!record||busy||!store)return;
  const key=record.key,endpoint=get('activityRpc').value.trim();controller=new AbortController();const signal=controller.signal;
  busy=true;render();get('activityStatus').textContent='正在逐笔核对交易。你可以随时取消。';
  try{
    for(const transaction of record.transactions){
      if(signal.aborted)break;const token=crypto.randomUUID();
      const current=await store.update(key,old=>beginCheck(old,transaction.hash,token));
      let result;
      try{result=await checkTransaction({endpoint,chainId:record.chainId,account:record.account,hash:transaction.hash,
        previous:current.transactions.find(tx=>tx.hash===transaction.hash).previous,
        signal:AbortSignal.any([signal,AbortSignal.timeout(30000)])});
      }catch(error){result={status:'error',error:Object.hasOwn(errors,error.message)?error.message:'RPC_UNAVAILABLE'};}
      if(signal.aborted)result={status:'error',error:'CANCELED'};
      await store.update(key,old=>finishCheck(old,transaction.hash,token,result));await refresh();
    }
    get('activityStatus').textContent=signal.aborted?'核对已取消。已保存的记录仍保留。':'本轮核对已完成。结果是节点当前观察，不代表最终确认。';
  }catch(error){get('activityStatus').textContent=message(error);}
  finally{busy=false;render();}
};
get('activityExport').onclick=async()=>{
  try{
    await refresh();const url=URL.createObjectURL(new Blob([JSON.stringify(publicReport(records),null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='aurven-activity-records.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    get('activityStatus').textContent='公开记录已导出，不含 RPC 地址或私密密钥。';
  }catch(error){get('activityStatus').textContent=message(error);}
};
window.addEventListener('pagehide',()=>controller?.abort());
window.addEventListener('pageshow',event=>{if(event.persisted&&store)refresh().catch(()=>{});});
