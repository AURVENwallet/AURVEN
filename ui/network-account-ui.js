import {networkWalletId,authorizeNetwork} from './vault-ui.js';
import {openVaultStore} from './vault-store.js';
import {trialEndpoint,payerAccount,inTbnb} from './browser-trial.js';
import {previewNetwork,submitNetwork,reconcileNetwork,checkOldApproval} from './network-account.js';
import {readAccount} from './account-state.js';

const el=id=>document.getElementById(id),endpoint=trialEndpoint;
const kinds={create:'建户并存入 3 wei',send:'转出 1 wei',rotate:'轮换签名密钥',fund:'再存入 3 wei'};
const states={pending:'付款钱包已提交，当前节点仍在等待打包。',unseen:'当前节点未找到这笔交易。请稍后再核对，或从付款钱包复制交易哈希。',
  replaced:'相同付款序号已被另一笔不同内容的交易使用。',reorg:'原回执所在区块已被替换，当前链上尚未核实这笔操作。',
  expired:'截至核对区块未发现已打包的付款，签名授权已过期。',preparing:'准备中',requested:'等待核对付款结果',waiting:'等待链上回执。',included:'交易回执已核对',declined:'付款请求已取消。',stopped:'准备已停止，尚未请求付款。',reverted:'交易已打包，但执行失败。'};
const errors={NET_CHECK_AGAIN:'另一处已更新此记录，请重新核对。',NET_UNVERIFIED:'本次核对未取得一致的链上证据，请稍后重试。',
  NET_ACCOUNT_LIMIT:'本浏览器最多可保存 8 个可复用测试账户，请使用已有账户。',
  NET_HISTORY_FULL:'交易历史已满，请先核对尚未确认的回执。',NET_VAULT:'请先解锁链 97 的原始测试密钥库。',RECOVERY:'只读备份无法签名。',LOCKED:'请先解锁链 97 的原始测试密钥库。',
  BUSY:'另一个页面正在保存密钥库，请稍后重试。',FULL:'一次性密钥记录已达到本版本上限，已停止操作。',
  TRIAL_PRICE:'当前 Gas 价格超过试转限制。',TRIAL_CLOCK:'区块时间或草稿有效期异常，请重新预览。',
  NET_ACCOUNT:'请先建户并核对建户回执。',NET_KEYS:'当前密钥库与账户密钥不匹配。',NET_BALANCE:'智能账户余额不足，请先存入测试币。',
  DRAFT_STALE:'账户状态已改变，请重新预览。',TRIAL_IN_USE:'同一笔付款已有试转记录，请先核对回执。',TRIAL_REPLY:'付款钱包的回复未确认。请核对原交易回执。',
  NET_WINDOW:'这笔授权已过期或叶号已用过，无法单独验证旧密钥。',NET_OLD:'请选择轮换前已确认的转账记录。',NET_NO_REJECTION:'未能核实签名拒绝原因。',
  NET_EXHAUSTED:'当前密钥的可用叶号已耗尽。',TRIAL_HASH:'该哈希与本次试转不符。',TRIAL_FULL:'本浏览器已达到 32 条试转记录上限。',
  TRIAL_PROVIDER:'请在支持浏览器钱包的网站环境中打开此页。',TRIAL_PAYER:'付款账户已改变，请重新连接。',TRIAL_CHAIN:'请先在付款钱包中切换到 BSC 测试网（97）。',
  TRIAL_NONCE:'付款钱包有其他交易，请等待确认并重新预览。',TRIAL_BALANCE:'付款钱包的测试币不足以覆盖本金和手续费上限。',TRIAL_RECIPIENT:'试转需要普通付款钱包和有效的普通收款地址。'};
let store,payer,plan,records=[],busy=false;
const storage=async()=>store??=await openVaultStore('aurven-vault-network-actions-v1');
const selected=()=>records.find(r=>r.id===el('netRecords').value);
function reset(){plan=undefined;el('netReview').hidden=true;}
function render(){
  const kind=el('netKind').value,row=selected();
  el('netAccountField').hidden=kind==='create';el('netToField').hidden=kind!=='send';
  for (const id of ['netConnect','netKind','netAccount','netTo','netRecords','netHash']) el(id).disabled=busy;
  el('netPreview').disabled=busy||!payer;el('netConfirm').disabled=busy||!plan;
  el('netHistory').hidden=!row;if (!row) return;
  el('netCheck').disabled=busy||!row.dataHash;el('netManual').hidden=!row.dataHash||['included','reverted','replaced'].includes(row.status);
  el('netOld').hidden=row.kind!=='send'||row.status!=='included';el('netOld').disabled=busy;
  const details=[states[row.status]??''];
  if (row.checkedBlock) details.unshift('上次核对区块 #'+BigInt(row.checkedBlock));
  if (!row.checkedBlock && ['included','reverted'].includes(row.status)) details.unshift('上次保存的回执');
  if (row.status==='replaced' && ['send','rotate'].includes(row.kind)) details.push('签名叶已保留。在授权有效期内，其他付款方仍可能提交原授权。');
  if (row.equivalent) details.push('相同操作以新的交易哈希打包。');
  if (row.moved) details.push('同一笔交易已在另一个区块重新打包。');
  if (['included','reverted'].includes(row.status) && row.feeWei!=null) details.push('Gas '+row.gasUsed,inTbnb(row.feeWei));
  el('netOutcome').textContent=details.join(' · ');
  const link=(id,hash)=>{
    const anchor=el(id);anchor.hidden=!hash;
    if (hash) anchor.href='https://testnet.bscscan.com/tx/'+hash;
    else anchor.removeAttribute('href');
  };
  link('netExplorer',row.hash);
  link('netReplacement',row.replacementHash);
  link('netOriginal',row.equivalent?row.submittedHash:null);
}
function options(select,items,preferred) {
  const prev=preferred||select.value;
  select.replaceChildren(...items.map(([value,label])=>{const o=document.createElement('option');o.value=value;o.textContent=label;return o;}));
  if(items.some(([v])=>v===prev)) select.value=prev;
}
async function refresh(preferred){
  records=(await (await storage()).read())?.rows??[];
  options(el('netRecords'),records.toReversed().map(r=>[r.id,kinds[r.kind]+' · '+r.account.slice(0,10)+' · nonce '+BigInt(r.nonce)]),preferred);
  options(el('netAccount'),records.filter(r=>r.kind==='create'&&r.status==='included').map(r=>[r.account,r.account]));
  render();
}
const status=s=>{el('netStatus').textContent=s;};
async function action(fn){
  if(busy)return;
  busy=true;render();
  try{await fn();}catch(e){status(e.code===4001?states.declined:errors[e.code??e.message]??'操作未完成，请查看试转记录并核对网络。');}
  finally{busy=false;render();}
}
async function check(row,hash){
  let result;
  try {
    result=await reconcileNetwork(await storage(),endpoint,row.id,hash);
  } catch (error) {
    if (['TRIAL_HASH','NET_CHECK_AGAIN','TRIAL_CHAIN'].includes(error.message)) throw error;
    throw new Error('NET_UNVERIFIED',{cause:error});
  } finally { await refresh(row.id); }
  if(result.status!=='included'){status(states[result.status]);return;}
  const s=await readAccount({endpoint,account:row.account,chainId:97});
  status('交易回执已核对 · '+s.balanceWei+' wei · epoch '+s.epoch+' · next '+s.next);
}
el('netConnect').onclick=()=>action(async()=>{reset();payer=await payerAccount(window.ethereum,true);if(!el('netTo').value)el('netTo').value=payer;status('已连接付款钱包 · '+payer);});
el('netPreview').onclick=()=>action(async()=>{
  reset();const walletId=networkWalletId(),kind=el('netKind').value,account=el('netAccount').value;
  if (kind!=='create' && !records.some(r=>r.kind==='create'&&r.walletId===walletId&&r.account===account&&r.status==='included')) throw new Error('NET_ACCOUNT');
  if (await payerAccount(window.ethereum)!==payer) throw new Error('TRIAL_PAYER');
  plan=await previewNetwork(endpoint,{walletId,payer,account,kind,recipient:el('netTo').value.trim()});
  el('netAction').textContent=kinds[kind];el('netAddress').textContent=plan.account;el('netPayer').textContent=payer;
  el('netDestination').textContent=kind==='rotate'?'仅轮换密钥':(kind==='send'?plan.recipient+' · 1 wei':plan.account+' · 3 wei');
  el('netFee').textContent=inTbnb(BigInt(plan.gas)*BigInt(plan.gasPrice));
  el('netReview').hidden=false;status('请核对地址和费用，再打开付款钱包确认。');
});
el('netConfirm').onclick=()=>action(async()=>{
  const approved=plan;if(!approved)return;plan=undefined;el('netHash').value='';
  try{
    const row=await submitNetwork({endpoint,store:await storage(),provider:window.ethereum,plan:approved,walletId:networkWalletId,
      authorize:async p=>{
        const result=await authorizeNetwork(p,n=>status('浏览器正在生成一次性签名… '+Math.round(n*100)+'%'));
        status('请在付款钱包中核对并确认。');return result;
      }});
    await check(row);
  }finally{reset();await refresh(approved.id);}
});
el('netCheck').onclick=()=>action(()=>check(selected(),el('netHash').value.trim().toLowerCase()));
el('netOld').onclick=()=>action(async()=>{
  const result=await checkOldApproval(endpoint,selected());status('旧授权已被合约拒绝 · '+result.reason+' · #'+BigInt(result.block));
});
el('netRecords').onchange=()=>{el('netHash').value='';render();};
for (const id of ['netKind','netAccount','netTo']) el(id).addEventListener('input',()=>{reset();render();});
for (const evt of ['accountsChanged','chainChanged']) window.ethereum?.on?.(evt,()=>{payer=undefined;reset();render();});
refresh().catch(()=>status('请检查浏览器是否允许本地存储。'));
