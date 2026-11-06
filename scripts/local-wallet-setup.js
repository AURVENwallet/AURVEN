// Served only by the loopback launcher, alongside the normal wallet page.
import {checkSandboxAccount,sandboxHandover,savedSandboxOffer} from '/vault-ui.js';
import {confirmLocalHandover,offerFingerprint,validateOffer} from '/local-handover.js';

const get=id=>document.getElementById(id);
const session=document.querySelector('meta[name="aurven-local-session"]').content;
const info=await fetch('/local/session.json',{credentials:'omit',redirect:'error'}).then(response=>{
  if (!response.ok) throw new Error('Local session unavailable');
  return response.json();
});
const button=get('pairLocal'), status=get('pairStatus'), link=get('openLocalDraft');
let pairing=false;
get('localSetup').hidden=false;
get('vaultChain').value='31337';
get('vaultChain').disabled=true;
get('vaultRestoreForm').closest('details').hidden=true;
get('localStart').hidden=true;
get('localSetupGuide').hidden=false;
// The six-receipt demo uses a different node and its own separately generated account.
get('loadDemo').closest('section').hidden=true;

function showAvailability() {
  const unlocked=get('vaultBadge').dataset.state==='open' && get('vaultRecovery').hidden;
  button.disabled=pairing || !unlocked;
  if (!unlocked) {
    link.hidden=true;
    status.textContent='先在上方创建或解锁本次演示的密钥库。';
  } else if (!pairing && link.hidden && !status.dataset.error) {
    status.textContent='密钥库已解锁，可以配对。';
  }
}
new MutationObserver(showAvailability).observe(get('vaultBadge'),{attributes:true,attributeFilter:['data-state']});
showAvailability();

button.onclick=async()=>{
  if (button.disabled) return;
  pairing=true;button.disabled=true;link.hidden=true;delete status.dataset.error;
  try {
    status.textContent='正在浏览器中计算公开根…';
    let result=await checkSandboxAccount(info.account,info.endpoint);
    if (!result) throw new Error();
    if (!result.matched) {
      if (result.snapshot.root!=='0x'+'00'.repeat(16)) throw new Error();
      const response=await fetch('/local/pair',{method:'POST',credentials:'omit',redirect:'error',
        headers:{'Content-Type':'text/plain','X-Aurven-Session':session},body:result.derivedRoot});
      if (!response.ok) throw new Error();
      status.textContent='公开根已写入，正在核对链上账户…';
      result=await checkSandboxAccount(info.account,info.endpoint);
    }
    if (!result?.matched || result.mode!=='active' || get('vaultBadge').dataset.state!=='open') throw new Error();
    document.dispatchEvent(new CustomEvent('aurven:watch-account',{detail:{...info,chainId:31337}}));
    const fields=get('transferForm').elements;
    fields.namedItem('recipient').value=info.recipient;
    fields.namedItem('amount').value='0.01';
    get('accountStatus').textContent='演示账户已配对，生成草稿时会重新同步。';
    link.hidden=false;
    status.textContent='配对完成。已填入 0.01 枚测试币，请核对后生成草稿。';
  } catch {
    status.dataset.error='true';
    status.textContent='配对未完成。请确认演示程序仍在运行，解锁本次密钥库后重试。';
  } finally {pairing=false;showAvailability();}
};

const handoverStatus=get('handoverStatus'), role=get('handoverRole');
let receiving,working=false;
get('handoverControls').hidden=false;get('handoverStart').hidden=true;
function displayHandover(){
  const open=get('vaultBadge').dataset.state==='open'&&get('vaultRecovery').hidden;
  receiving=savedSandboxOffer();
  get('handoverFields').disabled=working||!open;
  get('handoverReceive').hidden=role.value!=='receive';get('handoverSend').hidden=role.value!=='send';
  get('handoverOfferBox').hidden=!receiving||!open;
  get('handoverPrepare').disabled=!!receiving&&receiving.deadline>Date.now()/1000;
  get('handoverOutput').value=open&&receiving?JSON.stringify(receiving):'';
  get('handoverPrint').textContent=open&&receiving?offerFingerprint(receiving):'';
  if(!open){
    handoverStatus.textContent='先在上方创建或解锁本次演示的密钥库。';
    get('handoverContinue').hidden=true;
  }else if(!working && handoverStatus.dataset.locked==='yes')handoverStatus.textContent='';
  handoverStatus.dataset.locked=open?'no':'yes';
}
const handoverErrors={
  HANDOVER_OFFER:'接收请求格式有误，请重新复制完整请求。',
  HANDOVER_FINGERPRINT:'指纹或账户不符，请在接收设备重新核对。',
  HANDOVER_FRESH:'请在另一个浏览器配置文件中创建全新的演示密钥库。',
  HANDOVER_STALE:'请求已过期，或原账户状态已改变。请重新核对账户。',
  HANDOVER_SPENT:'本机已预留交接叶号。请先在接收设备查回执，勿重复提交。',
  HANDOVER_CHECK_RECEIPT:'交接叶号已预留，提交结果待核对。请在接收设备查回执。',
  HANDOVER_PENDING:'尚未确认接收根及后续区块。请等待打包后再核对。',
  HANDOVER_RECEIPT:'未能核实规范区块中的换根回执。',
  NET_KEYS:'当前密钥库与账户密钥不匹配。'
};
async function handoverAction(action){
  if(working||get('handoverFields').disabled)return;
  working=true;get('handoverContinue').hidden=true;
  handoverStatus.textContent='正在核对本机账户和密钥…';displayHandover();
  try{await action();}
  catch(error){handoverStatus.textContent=handoverErrors[error.code]??'交接未完成，请核对两端密钥库和本机链状态。';}
  finally{working=false;displayHandover();}
}
new MutationObserver(displayHandover).observe(get('vaultBadge'),{attributes:true,attributeFilter:['data-state']});
role.onchange=()=>{handoverStatus.textContent='';get('handoverContinue').hidden=true;displayHandover();};
displayHandover();
get('handoverPrepare').onclick=()=>handoverAction(async()=>{
  await sandboxHandover(info);
  handoverStatus.textContent='接收请求已就绪，十五分钟内有效。';
});
get('handoverAuthorize').onclick=()=>handoverAction(async()=>{
  let offer;
  try{offer=validateOffer(JSON.parse(get('handoverInput').value));}catch{throw {code:'HANDOVER_OFFER'};}
  const fingerprint=get('handoverFingerprint').value.trim().toLowerCase();
  if(offer.account!==info.account||offerFingerprint(offer)!==fingerprint)throw {code:'HANDOVER_FINGERPRINT'};
  const current=await checkSandboxAccount(info.account,info.endpoint);
  if(!current?.matched)throw {code:'NET_KEYS'};
  const hash=await sandboxHandover({...info,offer,fingerprint});
  handoverStatus.textContent='已提交本机换根交易 · '+hash;
});
get('handoverVerify').onclick=()=>handoverAction(async()=>{
  const receipt=await confirmLocalHandover(info.endpoint,receiving);
  const binding=await checkSandboxAccount(info.account,info.endpoint);
  if(!binding?.matched||binding.snapshot.root!==receiving.newRoot||binding.snapshot.epoch!==2)throw {code:'NET_KEYS'};
  const latest=await confirmLocalHandover(info.endpoint,receiving);
  if(latest.blockHash!==receipt.blockHash||latest.hash!==receipt.hash||get('vaultBadge').dataset.state!=='open')
    throw {code:'HANDOVER_RECEIPT'};
  handoverStatus.textContent='交接已核实，本机密钥与第二代链上根匹配。'+' #'+BigInt(receipt.blockNumber)+' · '+receipt.hash;
  get('handoverContinue').hidden=false;
});
