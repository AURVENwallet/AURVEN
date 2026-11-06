import {recoverTestnetRotation,validateRotationRecord} from './testnet-rotation.js';

const el=id=>document.getElementById(id);
const messages={
  current:'换根交易已核实，核验区块仍使用这棵密钥树。',
  superseded:'换根交易已核实，账户随后又轮换了密钥。',
  expired:'授权已过期，在核验区块尚未使用这笔付款序号。',
  waiting:'这笔付款尚未在双方认可的最终确认区块内收录。',
  replaced:'这个付款序号被另一笔交易使用，未核实所选换根。',
  reverted:'这笔交易已收录，但换根执行失败。',
  continue:'本段未找到交易，可继续查找下一段区块。',
  'not-found':'截至核验区块未找到交易。可稍后重查或填入已知哈希。',
  ROTATION_FILE:'请选择有效的测试网公开换根记录。',
  ROTATION_TX:'无法将所给哈希与该付款账户和序号对应。',
  ROTATION_NODES:'两个节点未能同时提供已最终确认的区块。',
  ROTATION_CONFLICT:'两个节点的记录不一致，本次无法确认换根。',
  ROTATION_CURSOR:'上次查找的区块已变化，请从头查找。',
  HANDOVER_PROOF:'旧密钥的签名与公开记录不符。',
  unavailable:'未取得完整的链上证据，请稍后重试。'
};
let controller,cursor;
function clear(){
  el('rotationResult').hidden=true;
  el('rotationExplorer').removeAttribute('href');el('rotationExplorer').textContent='';
  for(const id of ['rotationAccount','rotationBlock','rotationFinal','rotationRoot'])el(id).textContent='';
}
function reset(){
  controller?.abort();cursor=undefined;clear();el('rotationStatus').textContent='';
  el('rotationCheck').textContent='查找换根交易';
  el('rotationFileField').hidden=el('rotationSource').value!=='file';
}
for(const id of ['rotationSource','rotationFile','rotationHint'])el(id).addEventListener('input',reset);
el('rotationCancel').onclick=()=>controller?.abort();
async function readRecord(signal){
  if(el('rotationSource').value==='sample'){
    const response=await fetch(new URL('./assets/testnet-rotation-record.json',import.meta.url),{signal,redirect:'error'});
    if(!response.ok)throw new Error('ROTATION_FILE');
    return validateRotationRecord(await response.json());
  }
  const file=el('rotationFile').files[0];
  if(!file || file.size>4096)throw new Error('ROTATION_FILE');
  try{return validateRotationRecord(JSON.parse(await file.text()));}catch{throw new Error('ROTATION_FILE');}
}
el('rotationCheck').onclick=async()=>{
  if(controller)return;
  controller=new AbortController();
  clear();
  for(const id of ['rotationCheck','rotationSource','rotationHint','rotationFile'])el(id).disabled=true;
  el('rotationCancel').hidden=false;el('rotationStatus').textContent='正在查找付款并核对两个节点的最终确认记录…';
  try{
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(90000)]);
    const record=await readRecord(signal);
    const result=await recoverTestnetRotation(record,{cursor,txHash:el('rotationHint').value.trim().toLowerCase(),signal});
    signal.throwIfAborted();
    cursor=result.status==='continue'?result.cursor:undefined;
    let detail=' · '+'核验区块 #'+BigInt(result.checkedBlock);
    if(result.cursor)detail+=' · '+'已查至 #'+BigInt(result.cursor.number);
    el('rotationStatus').textContent=messages[result.status]+detail;
    if(['current','superseded'].includes(result.status)){
      el('rotationAccount').textContent=result.account;el('rotationBlock').textContent=String(BigInt(result.block));
      el('rotationFinal').textContent=String(BigInt(result.checkedBlock));el('rotationRoot').textContent=result.root+' · epoch '+result.epoch;
      el('rotationExplorer').textContent=result.hash;el('rotationExplorer').href='https://testnet.bscscan.com/tx/'+result.hash;
      el('rotationResult').hidden=false;
    }
  }catch(error){
    if(error.message==='ROTATION_CURSOR')cursor=undefined;
    el('rotationStatus').textContent=controller.signal.aborted?'查找已取消。':messages[error.message]??messages.unavailable;
  }finally{
    controller=undefined;el('rotationCancel').hidden=true;
    for(const id of ['rotationCheck','rotationSource','rotationHint','rotationFile'])el(id).disabled=false;
    el('rotationCheck').textContent=cursor?'继续查找下一段':'查找换根交易';
  }
};
el('rotationCheck').disabled=false;
