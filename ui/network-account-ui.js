import {secondaryTestnet as secondary} from './testnet-heads.js';
import {handoverFingerprint} from './vault-network-proof.js';
import {networkWalletId,authorizeNetwork,receivedTestnetAccount,receiveTestnetHandover} from './vault-ui.js';
import {openVaultStore} from './vault-store.js';
import {trialEndpoint,payerAccount,inTbnb} from './browser-trial.js';
import {previewNetwork,submitNetwork,reconcileNetwork,needsReceiptCheck,checkOldApproval} from './network-account.js';
import {compareNetworkReceipts} from './network-receipt.js';
import {readAccount} from './account-state.js';
import {exportRotationRecord} from './testnet-rotation.js';

const el=id=>document.getElementById(id),endpoint=trialEndpoint;

const exampleHash='0xd4375fec221a613bbe4caddc53fc04b00c6eb64214d5e5b87913b3f3e556a953';
const example={
  kind:'send',hash:exampleHash,
  lastInclusion:{hash:exampleHash,block:'0x868c549',blockHash:'0xff7e90c7798c988d190b38e87d281056d22b723623952091d14497b225fdbb20'},
  payer:'0x00e6344b5b447d5cf7975dac1b6037887aaa4566',nonce:'0x8',value:'0x0',startBlock:'0x868c4f9',
  account:'0x1b1853d31d483dceae241b0dca77ec4997ddd49a',deadline:1793940446,
  dataHash:'0x3009050b11bf3a86b71184e91ecbd628d0277b3a6268fc4c5de885d98eee316d',
  snapshot:{epoch:1},intent:{leaf:1,digest:'f6d5d8a4a1f5605bfec9e8f0a676fd6b'}
};
const kinds={create:'建户并存入 3 wei',send:'转出 1 wei',rotate:'轮换签名密钥',fund:'再存入 3 wei'};
const states={pending:'付款钱包已提交，当前节点仍在等待打包。',unseen:'当前节点未找到这笔交易。请稍后再核对，或从付款钱包复制交易哈希。',
  replaced:'相同付款序号已被另一笔不同内容的交易使用。',reorg:'原回执所在区块已被替换，当前链上尚未核实这笔操作。',
  expired:'截至核对区块未发现已打包的付款，签名授权已过期。',preparing:'准备中',requested:'等待核对付款结果',waiting:'等待链上回执。',included:'交易回执已核对',declined:'付款请求已取消。',stopped:'准备已停止，尚未请求付款。',reverted:'交易已打包，但执行失败。'};
const errors={HANDOVER_OFFER:'交接请求与账户、密钥或授权有效期不符。',HANDOVER_FINGERPRINT:'指纹不一致，请通过另一渠道向新设备核对。',
  HANDOVER_FRESH:'请使用全新、独立的链 97 密钥库接收该账户。',HANDOVER_RETIRED:'旧密钥已预留换根授权，请核对原回执。',
  HANDOVER_PENDING:'尚未核实本机接收密钥已最终生效，请核对回执后重试。',HANDOVER_RECEIPT:'换根记录与已保存的交接不同。',
  HANDOVER_SEARCH:'请先在下方找回换根交易，再填入查到的哈希。',HANDOVER_FILE:'请选择对应的公开交接文件。',ROTATION_FILE:'请选择有效的测试网公开换根记录。',
  ROTATION_NODES:'两个节点未能同时提供已最终确认的区块。',ROTATION_CONFLICT:'两个节点的记录不一致，本次无法确认换根。',NET_PREFLIGHT_UNAVAILABLE:'未能从两个测试网节点核实签名前状态，请稍后重新预览。',
  NET_PREFLIGHT_STATE:'两个节点报告的账户状态不同，请稍后重新预览。',
  NET_PREFLIGHT_FORK:'两个节点无法确认同一区块，请稍后重新预览。',NET_SETUP_OCCUPIED:'预计的建户地址已被占用，请重新预览。',
  NET_ACCOUNT_CHECK:'请重新核对建户回执，两个节点一致后再继续。',NET_CHECK_AGAIN:'另一处已更新此记录，请重新核对。',NET_UNVERIFIED:'本次核对未取得一致的链上证据，请稍后重试。',
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
let store,payer,plan,records=[],busy=false,receiveFeedback=false;
const storage=async()=>store??=await openVaultStore('aurven-vault-network-actions-v1');
const selected=()=>records.find(r=>r.id===el('netRecords').value);
function reset(){plan=undefined;el('netReview').hidden=true;}
function checkMessage(check) {
  const block=check.block?' #'+BigInt(check.block):'';
  if (check.kind==='agreed') return '两个节点核对一致'+block;
  if (check.kind==='single') {
    const source=check.source==='primary'?'仅主节点完成核对':'仅备用节点完成核对';
    return source+block+' · '+states[check.status];
  }
  if (check.kind==='conflict') {
    return (check.reason==='block'?'两个节点返回不同的区块。':'两个节点对这笔交易的结果不同。')+block;
  }
  return '两个节点均未完成核对，请稍后重试。';
}
function render(){
  const kind=el('netKind').value,row=selected();
  el('netHandoverFields').hidden=kind!=='handover';
  for(const id of ['netOffer','netFingerprint','receiveAddress','receivePrepare','receiveRecord','receiveHash','receiveAccept'])el(id).disabled=busy;
  el('netAccountField').hidden=kind==='create';el('netToField').hidden=kind!=='send';
  for (const id of ['netConnect','netKind','netAccount','netTo','netRecords','netHash']) el(id).disabled=busy;
  el('netPreview').disabled=busy||!payer;el('netConfirm').disabled=busy||!plan;
  el('netSample').disabled=busy;
  el('netHistory').hidden=!row;if (!row) return;
  el('netRotationExport').hidden=row.kind!=='rotate'||!row.intent||!row.dataHash;
  el('netRotationExport').disabled=busy;
  el('netCheck').disabled=busy||!row.dataHash;el('netManual').hidden=!row.dataHash||(!needsReceiptCheck(row)&&['included','reverted','replaced'].includes(row.status));
  el('netOld').hidden=row.kind!=='send'||row.status!=='included'||needsReceiptCheck(row);el('netOld').disabled=busy;
  const details=[states[row.status]??''];
  if (row.checkedBlock) details.unshift('上次核对区块 #'+BigInt(row.checkedBlock));
  if (!row.checkedBlock && ['included','reverted'].includes(row.status)) details.unshift('上次保存的回执');
  if (row.receiptCheck) {
    if (needsReceiptCheck(row)) details.unshift('此前保存的状态');
    details.unshift(checkMessage(row.receiptCheck));
  }
  if (row.status==='replaced' && ['send','rotate'].includes(row.kind)) details.push('签名叶已保留。在授权有效期内，其他付款方仍可能提交原授权。');
  if (row.leafReserved) details.push('本次签名叶已预留，后续不会用于签署其他请求。');
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
  options(el('netRecords'),records.toReversed().map(r=>[r.id,(r.offer?'交给新设备':kinds[r.kind])+' · '+r.account.slice(0,10)+' · nonce '+BigInt(r.nonce)]),preferred);
  listAccounts();
  render();
}
function listAccounts(){
  const accounts=records.filter(r=>r.kind==='create' && r.status==='included' && !needsReceiptCheck(r)).map(r=>r.account);
  const received=receivedTestnetAccount();if(received)accounts.push(received);
  options(el('netAccount'),[...new Set(accounts)].map(a=>[a,a]));
}
document.addEventListener('aurven:received-account',()=>{reset();listAccounts();render();});
const status=s=>{el('netStatus').textContent=s;if(receiveFeedback)el('receiveStatus').textContent=s;};
async function action(fn,receiving=false){
  if(busy)return;
  busy=true;receiveFeedback=receiving;render();
  try{await fn();}catch(e){status(e.code===4001?states.declined:errors[e.code??e.message]??'操作未完成，请查看试转记录并核对网络。');}
  finally{busy=false;receiveFeedback=false;render();}
}
async function check(row,hash){
  reset();
  let result;
  try {
    result=await reconcileNetwork(await storage(),endpoint,row.id,hash,secondary);
  } catch (error) {
    if (['TRIAL_HASH','NET_CHECK_AGAIN','TRIAL_CHAIN'].includes(error.message)) throw error;
    throw new Error('NET_UNVERIFIED',{cause:error});
  } finally { await refresh(row.id); }
  if (needsReceiptCheck(result)) {status(checkMessage(result.receiptCheck));return;}
  if(result.status!=='included'){status(states[result.status]);return;}
  // The live account snapshot is a separate read. Its failure cannot invalidate the saved receipt.
  status('交易回执已核对');
  try {
    const s=await readAccount({endpoint,account:row.account,chainId:97});
    status('最新账户状态（主节点） · '+s.balanceWei+' wei · epoch '+s.epoch+' · next '+s.next);
  } catch {status('交易回执已核对 · 暂时无法读取最新账户状态。');}
}
el('netConnect').onclick=()=>action(async()=>{reset();payer=await payerAccount(window.ethereum,true);if(!el('netTo').value)el('netTo').value=payer;status('已连接付款钱包 · '+payer);});
el('netPreview').onclick=()=>action(async()=>{
  reset();const walletId=networkWalletId(),isHandover=el('netKind').value==='handover',kind=isHandover?'rotate':el('netKind').value,account=el('netAccount').value;
  if (kind!=='create' && account!==receivedTestnetAccount() && !records.some(r=>r.kind==='create'&&r.walletId===walletId&&r.account===account&&r.status==='included'&&!needsReceiptCheck(r))) throw new Error('NET_ACCOUNT');
  if (await payerAccount(window.ethereum)!==payer) throw new Error('TRIAL_PAYER');
  const extra=isHandover?{offer:await readFile('netOffer'),fingerprint:el('netFingerprint').value.trim().toLowerCase()}:{};
  plan=await previewNetwork(endpoint,{walletId,payer,account,kind,recipient:el('netTo').value.trim(),...extra});
  el('netCheckedBlock').textContent='#'+BigInt(plan.reviewBlock.number);
  el('netKeyStateLabel').hidden=el('netKeyState').hidden=!plan.snapshot;
  if (plan.snapshot) el('netKeyState').textContent='密钥代数 '+plan.snapshot.epoch+' · 链上起始叶号 '+plan.snapshot.next;
  el('netAction').textContent=isHandover?'交给新设备':kinds[kind];el('netAddress').textContent=plan.account;el('netPayer').textContent=payer;
  el('netDestination').textContent=isHandover?plan.offer.newRoot+' · '+plan.fingerprint:kind==='rotate'?'仅轮换密钥':(kind==='send'?plan.recipient+' · 1 wei':plan.account+' · 3 wei');
  el('netFee').textContent=inTbnb(BigInt(plan.gas)*BigInt(plan.gasPrice));
  el('netReview').hidden=false;status('请核对地址和费用，再打开付款钱包确认。');
});
el('netConfirm').onclick=()=>action(async()=>{
  const approved=plan;if(!approved)return;plan=undefined;el('netHash').value='';
  try{
    const row=await submitNetwork({endpoint,store:await storage(),provider:window.ethereum,plan:approved,walletId:networkWalletId,
      authorize:async p=>{
        const result=await authorizeNetwork(p,n=>status('浏览器正在生成一次性签名… '+Math.round(n*100)+'%'));
        status('正在复核账户状态，再打开付款钱包…');return result;
      }});
    await check(row);
  }finally{reset();await refresh(approved.id);}
});
el('netSample').onclick=()=>action(async()=>{
  const out=el('netSampleResult');out.textContent='正在向两个节点核对回执…';
  try {
    const {check,observation}=await compareNetworkReceipts(endpoint,secondary,example);
    const details=[checkMessage(check)];
    if (observation) {
      details.push(states[observation.status]);
      if (observation.block) details.push('打包区块 #'+BigInt(observation.block),'Gas '+observation.gasUsed,inTbnb(observation.feeWei));
    }
    out.textContent=details.join(' · ');
  } catch {out.textContent='本次核对未取得一致的链上证据，请稍后重试。';}
});
el('netCheck').onclick=()=>action(()=>check(selected(),el('netHash').value.trim().toLowerCase()));
el('netOld').onclick=()=>action(async()=>{
  const result=await checkOldApproval(endpoint,selected());status('旧授权已被合约拒绝 · '+result.reason+' · #'+BigInt(result.block)+' · 主节点只读模拟');
});
el('netRecords').onchange=()=>{el('netHash').value='';render();};
el('netRotationExport').onclick=()=>{
  try{
    const record=exportRotationRecord(selected());
    const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)+'\n'],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='aurven-rotation-'+record.account+'-'+record.epoch+'.json';
    link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    status('公开记录已导出，可在另一浏览器核对回执。');
  }catch{status('这条历史记录缺少核对换根所需的字段。');}
};
async function readFile(id){
  const file=el(id).files[0];
  if(!file || file.size>4096)throw new Error('HANDOVER_FILE');
  try{return JSON.parse(await file.text());}catch{throw new Error('HANDOVER_FILE');}
}
el('receivePrepare').onclick=()=>action(async()=>{
  el('receiveCode').textContent='';el('receiveExpiry').textContent='';status('正在生成接收请求…');
  const offer=await receiveTestnetHandover(el('receiveAddress').value.trim().toLowerCase());
  const url=URL.createObjectURL(new Blob([JSON.stringify(offer,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='aurven-handover-request.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  el('receiveCode').textContent=handoverFingerprint(offer);
  el('receiveExpiry').textContent=new Date(offer.deadline*1000).toISOString();
  status(offer.deadline<=Date.now()/1000?'请求已过期。如旧设备已授权，请核对原回执。':'接收请求已导出，请单独传递指纹。');
},true);
el('receiveAddress').addEventListener('input',()=>{el('receiveCode').textContent='';el('receiveExpiry').textContent='';el('receiveStatus').textContent='';});
el('receiveAccept').onclick=()=>action(async()=>{
  status('正在核对两个节点的换根回执…');
  const receipt=await readFile('receiveRecord');
  if(!receipt)throw new Error('HANDOVER_FILE');
  const result=await receiveTestnetHandover(null,receipt,el('receiveHash').value.trim().toLowerCase());
  await refresh();el('netKind').value='send';el('netAccount').value=result.account;reset();render();
  status('新设备已接收账户，可预览 1 wei 测试转账。');
},true);
for (const id of ['netKind','netAccount','netTo','netOffer','netFingerprint']) el(id).addEventListener('input',()=>{reset();render();});
for (const evt of ['accountsChanged','chainChanged']) window.ethereum?.on?.(evt,()=>{payer=undefined;reset();render();});
refresh().catch(()=>status('请检查浏览器是否允许本地存储。'));
