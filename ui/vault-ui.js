import {openVaultStore} from './vault-store.js';
import {TestVault} from './vault-service.js';
import {MAX_BACKUP_BYTES} from './vault-crypto.js';
import {verifyLocalProof} from './local-proof.js';
const el=id=>document.getElementById(id);
const sessionId=document.querySelector('meta[name="aurven-local-session"]')?.content;
const sandboxStore=location.hostname==='127.0.0.1' && /^[a-f0-9]{32}$/.test(sessionId) ? 'aurven-sandbox-'+sessionId : undefined;
const status=el('vaultStatus');
let checkedBackupRevision, candidateList, lastReceivedAccount;
let vault,busy=false,details,building=false,signing=false,lastProof,checkingKeys=false;
const errors={
  HANDOVER_RECEIPT:'未能核实规范区块中的换根回执。',
  HANDOVER_PENDING:'尚未确认接收根及后续区块。请等待打包后再核对。',
  BACKUP_SOURCE:'这份文件与当前密钥库不对应。',
  BACKUP_INVALID:'无法验证备份文件，请检查文件是否完整。',
  RECOVERY_NODES:'两个测试网节点未能确认同一区块，请稍后重试。',
  RECOVERY_ACCOUNT:'未能在两个测试网节点读取此版本的账户，请检查地址或稍后重试。',
  RECOVERY_CONFLICT:'两个测试网节点的数据不一致，本次未生成核验结果。',
  SIGN_LOCAL:'本地试签仅支持本机 Anvil 节点和链号 31337。',
  SIGN_RESERVATION:'此预留已不可用于试签。请生成新草稿并重新预留。',
  SIMULATION:'本地合约模拟未通过。叶号仍已占用，请重新生成草稿。',
  DRAFT_REVIEW:'请先重新复核当前草稿，再预留叶号。',
  DRAFT_EXHAUSTED:'这棵树的交易叶已用尽，请先换根。',
  DRAFT_SOURCE:'请使用链上同步模式重新生成草稿。',
  DRAFT_FORMAT:'草稿字段无效，请重新生成。',
  DRAFT_DIGEST:'交易内容与草稿摘要不符，请重新生成。',
  DRAFT_KEYS:'请先用当前密钥库核验这个账户的密钥根。',
  DRAFT_STALE:'账户状态已变化，请重新同步并生成草稿。',
  DRAFT_DEADLINE:'草稿已过期或超出合约允许的时间，请重新生成。',
  DRAFT_BALANCE:'当前测试账户余额不足或余额数据无效。',
  DRAFT_LEAF:'本机使用日志已记录此叶号或更高叶号，请核对账户状态。',
  PASSWORD:'密码至少需要 12 个字符，请使用独立的长密码。',
  PASSWORD_MATCH:'两次输入的密码不一致。',
  AUTH_FAILED:'密码错误或备份已损坏，未解锁任何密钥。',
  FORMAT:'备份格式不受支持或数据已损坏。',
  UNSUPPORTED:'当前浏览器不支持所需的加密与存储功能，请使用支持 HTTPS 和 Web Locks 的浏览器。',
  STORAGE:'本地存储不可用，操作已停止。请检查浏览器的存储设置。',
  EXISTS:'此浏览器已有密钥库，不能用新建或恢复操作覆盖。',
  MISSING:'未找到本地密钥库，请先创建或恢复测试备份。',
  LOCKED:'密钥库已锁定，请重新输入密码。',
  BUSY:'另一个页面正在保存密钥库，请稍后重试。',
  ROLLBACK:'检测到较旧的密钥记录，已停止操作。',
  CONFLICT:'存储记录发生变化，已锁定，请重新检查。',
  RECOVERY:'恢复的备份仅供查看，本版本禁止使用它签名。',
  NETWORK:'仅支持 BSC 测试网和本地测试链。',
  USED:'此一次性密钥已被记录为使用过，不能再次签名。',
  FULL:'一次性密钥记录已达到本版本上限，已停止操作。',
  MESSAGE:'请输入 1 至 280 个字符的测试消息。',
  TREE_REQUIRED:'请先生成验证密钥树。',
  PROOF_CONTEXT:'签名上下文不匹配，操作已停止。',
  PROOF_FORMAT:'公开证明格式无效。',
  PROOF_VERIFY:'签名自检未通过，该叶号仍保持已使用。',
  CANCELED:'操作已取消。已保存的叶号不会被重新使用。',
  WORKER:'后台计算不可用。请使用支持模块 Worker 的浏览器。',
  WORKER_TIMEOUT:'后台计算超时，操作已停止。',
  KEY_CONTEXT:'账户核验上下文不匹配，未保留核验结果。',
  ACCOUNT_CHANGED:'核验期间账户状态发生变化，请重新核验。'
};
const grid=el('proofLeafGrid');
for(let index=0;index<64;index++){const tile=document.createElement('i');grid.append(tile);}
function renderProof(){
  const unlocked=!!vault?.unlocked,tree=vault?.proofTree;
  const active=unlocked&&details?.mode==='active';
  el('proofBuild').disabled=busy||!active||!!tree;
  el('proofBuild').textContent=tree?'验证树已就绪':'生成验证密钥树';
  el('proofCancel').hidden=!building;
  el('proofSignFields').disabled=busy||!active||!tree||tree.nextLeaf>=1024;
  el('proofGuide').textContent=!unlocked?'先创建并解锁上方测试密钥库。':!active?'恢复的备份仅供查看，不能进行签名自检。':tree?'验证树已就绪。输入消息后签名。':'生成需要一些时间，进度会实时显示。';
  el('proofUsed').textContent=tree?String(tree.used):'—';el('proofNext').textContent=tree?String(tree.nextLeaf):'—';
  el('proofRoot').textContent=tree?.root??'—';el('proofPubSeed').textContent=tree?.pubSeed??'—';
  for(const [index,tile] of [...grid.children].entries())tile.className=tree&&index*16<tree.nextLeaf?'used':'';
  el('proofStepBuild').dataset.state=building?'current':tree?'done':'';
  el('proofStepReserve').dataset.state=signing?'current':lastProof?'done':'';
  el('proofStepVerify').dataset.state=lastProof?'done':'';
  el('proofResult').hidden=!lastProof;
  el('proofExport').disabled=busy||!lastProof;el('proofTamper').disabled=busy||!lastProof;
}
function render(){
  details=vault?.details??details;
  const exists=!!details,unlocked=!!vault?.unlocked;
  el('vaultSetup').hidden=exists;el('vaultExisting').hidden=!exists;
  el('vaultUnlockForm').hidden=unlocked;el('vaultActions').hidden=!unlocked;
  el('vaultRecovery').hidden=details?.mode!=='recovery-readonly';
  el('backupInspect').hidden=!unlocked||details?.mode!=='active';
  if(!unlocked||details?.revision!==checkedBackupRevision)el('backupInspectResult').textContent='';
  el('vaultBadge').textContent=!exists?'尚未创建':unlocked?'已解锁':'已锁定';
  el('vaultBadge').dataset.state=unlocked?'open':'locked';
  el('vaultId').textContent=details?.walletId??'—';
  el('vaultNetwork').textContent=details?.chainId===97?'BSC Testnet · 97':details?.chainId===31337?'Anvil · 31337':'—';
  el('vaultRecords').textContent=unlocked&&details?.reservations!==null?String(details.reservations):'—';
  document.querySelectorAll('.vault-fields').forEach(fieldset=>{fieldset.disabled=busy||!vault;});
  el('vaultExport').disabled=busy||!unlocked;
  el('vaultLock').disabled=!unlocked;
  renderProof();
  renderAccountCheck();
  const received=receivedTestnetAccount();
  if(received!==lastReceivedAccount){lastReceivedAccount=received;document.dispatchEvent(new Event('aurven:received-account'));}
}
function renderAccountCheck(){
  const result=vault?.accountCheck;
  const recovery=!!vault?.unlocked&&details?.mode==='recovery-readonly'&&details.chainId===97;
  el('backupLookup').hidden=el('backupSourceChoice').hidden=el('backupAccountsLink').hidden=!recovery;
  const addresses=recovery?vault.recoveredAccounts:[];
  const listKey=recovery?addresses.join(','):null;
  if(listKey!==candidateList){
    const select=el('backupCandidates');
    select.replaceChildren(new Option('手动输入账户地址',''),...addresses.map(a=>new Option(a,a)));
    if(recovery&&addresses.length&&!el('accountKeyAddress').value){
      select.value=addresses[0];el('accountKeyAddress').value=addresses[0];
    }
    candidateList=listKey;
  }
  el('backupCandidateHint').textContent=!recovery?'':addresses.length?
    '地址来自备份中的预留记录，需核对链上部署。点击核验后才会查询该地址。':
    '这份备份没有记录账户地址。若另存了地址，可手动输入。';
  const dual=recovery&&!el('backupCustomRpc').checked;
  el('accountKeyRpcField').hidden=el('accountKeyRpc').disabled=dual;
  el('accountKeyRpc').required=!dual;
  el('accountKeyCheck').textContent=dual?'用两个测试网节点核验':'重建密钥树并核验';
  el('accountKeyFields').disabled=busy||!vault?.unlocked;
  el('accountKeyCancel').hidden=!checkingKeys;
  el('accountKeyNetwork').textContent=details?.chainId===97?'BSC Testnet · 97':details?.chainId===31337?'Anvil · 31337':'—';
  el('accountKeyResult').hidden=!result;
  el('accountKeySourceNote').textContent=!result?'':result.backupReview?
    '两处测试网节点在所示区块报告了相同的账户状态。':
    '结果只对应所示区块和当前解锁会话，不是可对外验证的所有权证明。单个 RPC 仍可能提供错误信息。';
  el('backupChainResult').hidden=!result?.backupReview;
  for(const id of ['backupBalance','backupRowCount','backupLastLeaf'])el(id).textContent='';
  if(!result){
    for(const id of ['accountKeyOutcome','accountKeyDerived','accountKeyOnchain','accountKeyEpoch','accountKeyNext','accountKeyBlock','accountKeyTime'])el(id).textContent='';
    return;
  }
  if(result.backupReview){
    el('backupBalance').textContent=result.snapshot.balanceWei+' wei';
    el('backupRowCount').textContent=String(result.backupReview.currentTreeReservations);
    const recorded=result.backupReview.lastChainLeafRecorded;
    el('backupLastLeaf').textContent=recorded===null?'本代尚未消耗链上叶号。':
      '#'+(result.snapshot.next-1)+(recorded?' · 备份中有此预留记录。':' · 备份中缺少此预留记录。');
  }
  el('accountKeyOutcome').textContent=result.matched?'密钥根匹配':'密钥根不匹配';
  el('accountKeyOutcome').dataset.match=String(result.matched);
  el('accountKeyDerived').textContent=result.derivedRoot;el('accountKeyOnchain').textContent=result.snapshot.root;
  el('accountKeyEpoch').textContent=String(result.snapshot.epoch);el('accountKeyNext').textContent=String(result.snapshot.next);
  el('accountKeyBlock').textContent=BigInt(result.snapshot.blockNumber).toString();
  el('accountKeyTime').textContent=new Date(result.checkedAt).toLocaleString();
  el('accountKeyRecovery').hidden=result.mode!=='recovery-readonly';
}
function notifyKeyChange(){document.dispatchEvent(new Event('aurven:key-check-cleared'));}
function clearAccountCheck(){vault?.cancelAccountCheck();notifyKeyChange();renderAccountCheck();}
async function draftAction(action) {
  try {
    if (!vault?.unlocked) throw {code:'LOCKED'};
    return await action(vault);
  } catch (error) {
    throw new Error(errors[error.code] ?? '草稿复核失败，请检查测试网络和节点后重试。');
  } finally {
    render();
  }
}
export const walletDraftActions = {
  simulate:(receipt,signal)=>draftAction(v=>v.simulateReservedTransfer(receipt,signal)),
  review:(draft,endpoint,signal)=>draftAction(v=>v.reviewTransferDraft(draft,endpoint,signal)),
  reserve:(draft,endpoint,report,signal)=>draftAction(v=>v.reserveTransferDraft(draft,endpoint,report,signal)),
  nextLeaf:state=>vault?.unlocked ? draftAction(v=>v.suggestedTransferLeaf(state)) : state.next
};
export function networkWalletId() {
  if (!vault?.unlocked || vault.details.mode!=='active' || vault.details.chainId!==97) throw new Error('NET_VAULT');
  return vault.details.walletId;
}
export const receivedTestnetAccount=()=>vault?.receivedAccount??null;
export async function receiveTestnetHandover(account,record,hash){
  networkWalletId();
  try{return record?await vault.acceptTestnetHandover(record,hash):await vault.prepareTestnetHandover(account);}
  finally{details=await vault.inspect();render();}
}
export async function authorizeNetwork(plan,progress) {
  networkWalletId();
  try {return await vault.authorizeNetworkAction(plan,progress);}
  finally {details=await vault.inspect();render();}
}
el('accountKeyForm').addEventListener('input',event=>{
  if(event.target===el('backupCandidates'))el('accountKeyAddress').value=event.target.value;
  if(event.target===el('accountKeyAddress'))el('backupCandidates').value=
    vault?.recoveredAccounts.includes(event.target.value.toLowerCase())?event.target.value.toLowerCase():'';
  clearAccountCheck();el('accountKeyStatus').textContent='信息已修改，请重新核验。';
});
document.addEventListener('aurven:check-account-keys',event=>{
  if(checkingKeys)vault?.cancelAccountCheck();else clearAccountCheck();
  el('accountKeyAddress').value=event.detail.account;el('accountKeyRpc').value=event.detail.endpoint;
  if(vault?.unlocked&&details?.mode==='recovery-readonly'){
    el('backupCandidates').value=event.detail.account.toLowerCase();
    el('backupCustomRpc').checked=!!event.detail.endpoint;renderAccountCheck();
  }
  el('accountKeyStatus').textContent=details&&details.chainId!==event.detail.chainId?
    '所选账户网络与密钥库不同，请使用对应网络的测试密钥库。':'账户信息已填入。解锁对应密钥库后开始核验。';
  location.hash='accountBinding';
});
async function checkAccountForm() {
  if(busy||!vault?.unlocked)return;
  busy=true;checkingKeys=true;vault.cancelAccountCheck();
  notifyKeyChange();
  el('accountKeyProgressBox').hidden=false;el('accountKeyProgress').value=0;el('accountKeyPercent').textContent='0%';
  el('accountKeyStatus').textContent='读取账户并重建对应密钥树，完成后会再次核对链上状态。';render();
  try{
    const result=await vault.checkAccountKeys({account:el('accountKeyAddress').value,endpoint:el('accountKeyRpc').value.trim(),
      fromBackup:!el('backupLookup').hidden&&!el('backupCustomRpc').checked},value=>{
      el('accountKeyProgress').value=Math.round(value*1024);el('accountKeyPercent').textContent=Math.round(value*100)+'%';
    });
    el('accountKeyStatus').textContent=result.matched?'密钥根与核验区块中的账户状态一致。此结果不启用交易签名。':
      '当前密钥库未能重建该账户的密钥根。请检查账户、网络和密钥库。';
    return result;
  }catch(error){el('accountKeyStatus').textContent=errors[error.code]??'核验未完成，请检查账户地址、RPC 网络和连接后重试。';}
  finally{checkingKeys=false;busy=false;el('accountKeyProgressBox').hidden=true;render();}
}
el('accountKeyForm').addEventListener('submit',event=>{event.preventDefault();void checkAccountForm();});
export async function checkSandboxAccount(account,endpoint) {
  if (!sandboxStore || !vault?.unlocked || vault.details.mode!=='active' || vault.details.chainId!==31337 ||
      !/^0x[a-f0-9]{40}$/.test(account) || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(endpoint)) return;
  el('accountKeyAddress').value=account;
  el('accountKeyRpc').value=endpoint;
  return checkAccountForm();
}
el('accountKeyCancel').addEventListener('click',()=>vault?.cancelAccountCheck());
export async function sandboxHandover(request){
  if(!sandboxStore||busy||!vault?.unlocked)throw {code:'LOCKED'};
  busy=true;render();
  try{return await vault.localHandover(request);}
  finally{busy=false;render();}
}
export function savedSandboxOffer(){return sandboxStore?vault?.receivingOffer:null;}
async function run(action){
  if(busy||!vault)return;
  busy=true;render();status.textContent='正在处理本地加密数据…';
  try{await action();}
  catch(error){status.textContent=errors[error.code]??'操作未完成，密钥数据未发送到网络。';}
  finally{
    document.querySelectorAll('.key-vault input[type="password"]').forEach(input=>{input.value='';});
    el('vaultFile').value='';busy=false;
    try{details=await vault.inspect();}catch{vault.lock('storage');}
    render();
  }
}
el('vaultCreateForm').addEventListener('submit',event=>{
  event.preventDefault();
  run(async()=>{
    if(el('vaultNewPassword').value!==el('vaultConfirmPassword').value){const error=new Error();error.code='PASSWORD_MATCH';throw error;}
    details=await vault.create(el('vaultNewPassword').value,Number(el('vaultChain').value));
    status.textContent='测试密钥库已创建。请导出加密备份并妥善保存密码。';
    el('proofStatus').textContent='生成需要一些时间，进度会实时显示。';
  });
});
el('vaultUnlockForm').addEventListener('submit',event=>{
  event.preventDefault();
  run(async()=>{
    details=await vault.unlock(el('vaultPassword').value);
    status.textContent=details.mode==='recovery-readonly'?'备份已解锁，仅供查看。签名保持禁用。':'密钥库已解锁，两分钟无操作后自动锁定。';
    el('proofStatus').textContent=details.mode==='recovery-readonly'?'恢复的备份仅供查看，不能进行签名自检。':'生成需要一些时间，进度会实时显示。';
  });
});
el('vaultRestoreForm').addEventListener('submit',event=>{
  event.preventDefault();
  run(async()=>{
    const file=el('vaultFile').files[0];
    if(!file||file.size>MAX_BACKUP_BYTES){const error=new Error();error.code='FORMAT';throw error;}
    details=await vault.restoreBackup(await file.text(),el('vaultBackupPassword').value);
    status.textContent='备份已恢复为只读密钥库。旧备份不能证明一次性密钥从未被使用，签名保持禁用。';
    el('proofStatus').textContent='恢复的备份仅供查看，不能进行签名自检。';
  });
});
el('vaultLock').addEventListener('click',()=>{vault?.lock();render();});
el('backupInspectFile').addEventListener('change',()=>{el('backupInspectResult').textContent='';});
el('backupInspectForm').addEventListener('submit',event=>{
  event.preventDefault();
  run(async()=>{
    const file=el('backupInspectFile').files[0];
    el('backupInspectResult').textContent='';
    if(!file||file.size>MAX_BACKUP_BYTES)throw {code:'FORMAT'};
    const report=await vault.checkBackupFile(await file.text());
    checkedBackupRevision=report.checkedRevision;
    const verdict={matches:'核对时，本机与备份的使用记录一致。',older:'这份备份落后于本机记录，请重新导出。',different:'使用记录出现分歧，无法确认这份备份的完整性。'};
    el('backupInspectResult').textContent=verdict[report.status]+' '+
      '备份记录数 '+report.savedCount+' / '+'本机记录数 '+report.currentCount;
    status.textContent='已完成本机备份核对。';
  });
});
el('vaultExport').addEventListener('click',()=>run(async()=>{
  const backup=await vault.exportBackup();
  const url=URL.createObjectURL(new Blob([backup],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='aurven-test-vault-'+vault.details.walletId.slice(0,8)+'.json';
  link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  status.textContent='已发起加密备份下载。请确认文件已保存，并将密码分开保管。';
}));
async function proofAction(action){
  if(busy||!vault)return;busy=true;render();
  try{await action();}
  catch(error){el('proofStatus').textContent=errors[error.code]??'操作未完成，密钥数据未发送到网络。';}
  finally{building=false;signing=false;busy=false;el('proofBuildProgress').hidden=true;try{details=await vault.inspect();}catch{vault.lock('storage');}render();}
}
el('proofBuild').addEventListener('click',()=>proofAction(async()=>{
  building=true;lastProof=undefined;el('proofBuildProgress').hidden=false;
  el('proofProgress').value=0;el('proofPercent').textContent='0%';
  el('proofStatus').textContent='正在生成验证密钥树，页面仍可操作。';render();
  await vault.buildProofTree(progress=>{el('proofProgress').value=Math.round(progress*1024);el('proofPercent').textContent=Math.round(progress*100)+'%';});
  el('proofStatus').textContent='完整验证树已生成。私密签名材料只在当前会话中使用。';
}));
el('proofCancel').addEventListener('click',()=>{vault?.cancelProof();lastProof=undefined;render();});
el('proofSignForm').addEventListener('submit',event=>{
  event.preventDefault();proofAction(async()=>{
    signing=true;lastProof=undefined;el('proofTamperStatus').textContent='';
    el('proofStatus').textContent='正在保存叶号记录，然后生成并核验签名。';render();
    const proof=await vault.signProofMessage(el('proofMessage').value);
    lastProof=proof;el('proofSignedLeaf').textContent=String(proof.leaf);
    el('proofSignedMessage').textContent=proof.message;el('proofDigest').textContent=proof.digest;
    el('proofStatus').textContent='签名通过本地核验。该叶号已消耗，不会再次使用。';
  });
});
el('proofExport').addEventListener('click',()=>{
  if(!lastProof||busy)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(lastProof,null,2)+'\n'],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='aurven-public-proof-'+lastProof.leaf+'.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  el('proofStatus').textContent='已发起公开证明下载，文件包含测试消息，不包含私密种子。';
});
el('proofTamper').addEventListener('click',()=>{
  if(!lastProof||busy)return;
  const first=lastProof.message[0]==='X'?'Y':'X';
  const tampered={...lastProof,message:first+Array.from(lastProof.message).slice(1).join('')};
  el('proofTamperStatus').textContent=!verifyLocalProof(tampered)?'篡改消息已被拒绝。原始证明保持不变。':'篡改验证异常，请停止使用。';
});
for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>vault?.touch(),{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden)vault?.lock('hidden');});
window.addEventListener('pagehide',()=>vault?.lock('hidden'));
window.addEventListener('pageshow',()=>{vault?.lock('navigation');render();});
try{
  if(!isSecureContext||!crypto.subtle||!navigator.locks)throw {code:'UNSUPPORTED'};
  vault=new TestVault(await openVaultStore(sandboxStore),{onLock:reason=>{
    if(details?.mode==='recovery-readonly')el('accountKeyAddress').value='';
    el('backupCustomRpc').checked=false;el('backupInspectFile').value='';
    el('backupInspect').open=false;checkedBackupRevision=undefined;
    notifyKeyChange();
    el('accountKeyProgressBox').hidden=true;
    el('accountKeyStatus').textContent='密钥库已锁定，核验结果已清除。';
    lastProof=undefined;el('proofBuildProgress').hidden=true;
    el('proofStatus').textContent='密钥库已锁定。后台计算已终止，重新解锁后需再次生成验证树。';
    status.textContent=reason==='manual'?'密钥库已锁定。':'密钥库已自动锁定，请重新输入密码。';render();
  }});
  details=await vault.inspect();
  status.textContent=details?'本地密钥库已就绪，输入密码解锁。':'创建新的测试密钥，或恢复已有的加密测试备份。';
}catch(error){vault=undefined;status.textContent=errors[error.code]??errors.STORAGE;}
render();
