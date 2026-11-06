import {accountRpc} from './account-state.js';
import {trialEndpoint,payerAccount,previewTrial,recoverTrial,requireTrial,inTbnb} from './browser-trial.js';
import {openTrialStore,updateTrial} from './browser-trial-store.js';
import {submitTrial} from './browser-trial-submit.js';
import {ProofWorkerClient} from './proof-worker-client.js';

const el=id=>document.getElementById(id);
const rpc=accountRpc(trialEndpoint);
const errors={
  TRIAL_LOOKUP:'节点限制了历史查询。请粘贴付款钱包里的交易哈希再核对。',
  TRIAL_REPLY:'付款钱包的回复未确认。请核对原交易回执。',
  TRIAL_PROVIDER:'请在支持浏览器钱包的网站环境中打开此页。',TRIAL_CHAIN:'请先在付款钱包中切换到 BSC 测试网（97）。',
  TRIAL_PAYER:'付款账户已改变，请重新连接。',TRIAL_NONCE:'付款钱包有其他交易，请等待确认并重新预览。',
  TRIAL_RECIPIENT:'试转需要普通付款钱包和有效的普通收款地址。',TRIAL_PRICE:'当前 Gas 价格超过试转限制。',
  TRIAL_BALANCE:'付款钱包的测试币不足以覆盖本金和手续费上限。',TRIAL_CLOCK:'区块时间或草稿有效期异常，请重新预览。',
  TRIAL_HASH:'该哈希与本次试转不符。',TRIAL_RECEIPT:'回执仍待核实，请稍后重试。',
  TRIAL_IN_USE:'同一笔付款已有试转记录，请先核对回执。',TRIAL_FULL:'本浏览器已达到 32 条试转记录上限。',
  TRIAL_STORAGE:'请检查浏览器是否允许本地存储。',STORAGE:'请检查浏览器是否允许本地存储。',
  TRIAL_DATA:'试转合约校验失败。',CONFLICT:'记录已在另一标签页更新，请刷新。'
};
const states={preparing:'已开始准备，尚未请求付款。',requested:'已请求付款。请核对回执，或粘贴付款钱包里的交易哈希。',
  waiting:'等待链上回执。',included:'已核对转账回执',reverted:'测试网交易已回滚。',declined:'付款请求已取消。',stopped:'准备已停止，尚未请求付款。'};
const status=text=>{el('trialStatus').textContent=text;};
const errText=e=>e.code===4001?states.declined:errors[e.message]??'操作未完成，请查看试转记录并核对网络。';
let payer,plan,rows=[],busy=false,store,worker;
const provider=()=>window.ethereum;
async function storage() {return store??=await openTrialStore();}
function resetPlan() {plan=undefined;el('trialReview').hidden=true;}
const selected=()=>rows.find(row=>row.id===el('trialRuns').value);
function displayRecord() {
  const row=selected();
  el('trialHistory').hidden=!row;
  if (!row) return;
  const canCheck=!!row.dataHash;
  el('trialCheck').disabled=busy || !canCheck;
  el('trialManual').hidden=!canCheck || !!row.hash;
  el('trialOutcome').textContent=(states[row.status]??'')+(row.status==='included'?' · Gas '+row.gasUsed+' · '+inTbnb(row.feeWei):'');
  const link=el('trialExplorer');
  link.hidden=!row.hash;
  if (row.hash) link.href='https://testnet.bscscan.com/tx/'+row.hash;
  else link.removeAttribute('href');
}
async function loadRows(preferred) {
  rows=(await (await storage()).read())?.rows??[];
  const select=el('trialRuns'),previous=preferred || select.value;
  select.replaceChildren(...rows.toReversed().map(row=>{
    const option=document.createElement('option');option.value=row.id;
    option.textContent=row.payer.slice(0,8)+'…'+row.payer.slice(-4)+' · nonce '+BigInt(row.nonce)+' · '+row.account.slice(0,10);
    return option;
  }));
  if (rows.some(row=>row.id===previous)) select.value=previous;
  displayRecord();
}
async function action(fn) {
  if (busy) return;
  busy=true;controls();
  try {await fn();}
  catch(e) {status(errText(e));}
  finally {busy=false;controls();}
}
function controls() {
  el('trialConnect').disabled=busy;el('trialRecipient').disabled=busy;
  el('trialPreview').disabled=busy || !payer;el('trialSend').disabled=busy || !plan;
  el('trialRuns').disabled=busy;el('trialHash').disabled=busy;displayRecord();
}
async function checkRow(row,hash) {
  const result=await recoverTrial(trialEndpoint,rpc,row,hash);
  await updateTrial(await storage(),row.id,old=>({...old,...result}));
  await loadRows(row.id);
  status(result.status==='included'?states.included:states[result.status]);
}
el('trialRuns').onchange=()=>{el('trialHash').value='';displayRecord();};
el('trialCheck').onclick=()=>action(()=>checkRow(selected(),el('trialHash').value.trim().toLowerCase()));
el('trialRecipient').oninput=resetPlan;
el('trialConnect').onclick=()=>action(async()=>{
  resetPlan();payer=await payerAccount(provider(),true);
  if (!el('trialRecipient').value) el('trialRecipient').value=payer;
  status('已连接付款钱包 · '+payer);
});
el('trialPreview').onclick=()=>action(async()=>{
  resetPlan();
  requireTrial(await payerAccount(provider())===payer,'TRIAL_PAYER');
  plan=await previewTrial(rpc,payer,el('trialRecipient').value.trim());
  el('trialPayer').textContent=plan.payer;el('trialTo').textContent=plan.recipient;
  el('trialCost').textContent=inTbnb(BigInt(plan.gas)*BigInt(plan.gasPrice));
  el('trialReview').hidden=false;status('请核对地址和费用，再打开付款钱包确认。');
});
el('trialSend').onclick=()=>action(async()=>{
  const confirmed=plan;if (!confirmed) return;
  plan=undefined;el('trialHash').value='';
  try {
    status('浏览器正在生成一次性签名…');
    const row=await submitTrial({store:await storage(),plan:confirmed,rpc,provider:provider(),build:async input=>{
      worker=new ProofWorkerClient(new URL('./browser-trial-worker.js',import.meta.url));
      try {
        const data=await worker.request('trial',input,p=>status('浏览器正在生成一次性签名… '+Math.round(p*100)+'%'));
        status('请在付款钱包中核对并确认。');return data;
      } finally {worker.dispose();worker=undefined;}
    }});
    await loadRows(row.id);
    await checkRow(row);
  } finally {resetPlan();await loadRows(confirmed.id);}
});
provider()?.on?.('chainChanged',()=>{payer=undefined;resetPlan();controls();});
provider()?.on?.('accountsChanged',()=>{payer=undefined;resetPlan();controls();});
window.addEventListener('pagehide',()=>worker?.dispose());
loadRows().catch(()=>status(errors.TRIAL_STORAGE));
