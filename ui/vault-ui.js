import {openVaultStore} from './vault-store.js';
import {TestVault} from './vault-service.js';
import {MAX_BACKUP_BYTES} from './vault-crypto.js';
import {verifyLocalProof} from './local-proof.js';
const el=id=>document.getElementById(id);
const status=el('vaultStatus');
let vault,busy=false,details,building=false,signing=false,lastProof,checkingKeys=false;
const errors={
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
}
function renderAccountCheck(){
  const result=vault?.accountCheck;
  el('accountKeyFields').disabled=busy||!vault?.unlocked;
  el('accountKeyCancel').hidden=!checkingKeys;
  el('accountKeyNetwork').textContent=details?.chainId===97?'BSC Testnet · 97':details?.chainId===31337?'Anvil · 31337':'—';
  el('accountKeyResult').hidden=!result;
  if(!result)return;
  el('accountKeyOutcome').textContent=result.matched?'密钥根匹配':'密钥根不匹配';
  el('accountKeyOutcome').dataset.match=String(result.matched);
  el('accountKeyDerived').textContent=result.derivedRoot;el('accountKeyOnchain').textContent=result.snapshot.root;
  el('accountKeyEpoch').textContent=String(result.snapshot.epoch);el('accountKeyNext').textContent=String(result.snapshot.next);
  el('accountKeyBlock').textContent=BigInt(result.snapshot.blockNumber).toString();
  el('accountKeyTime').textContent=new Date(result.checkedAt).toLocaleString();
  el('accountKeyRecovery').hidden=result.mode!=='recovery-readonly';
}
function clearAccountCheck(){vault?.cancelAccountCheck();renderAccountCheck();}
el('accountKeyForm').addEventListener('input',()=>{
  clearAccountCheck();el('accountKeyStatus').textContent='信息已修改，请重新核验。';
});
document.addEventListener('aurven:check-account-keys',event=>{
  if(checkingKeys)vault?.cancelAccountCheck();else clearAccountCheck();
  el('accountKeyAddress').value=event.detail.account;el('accountKeyRpc').value=event.detail.endpoint;
  el('accountKeyStatus').textContent=details&&details.chainId!==event.detail.chainId?
    '所选账户网络与密钥库不同，请使用对应网络的测试密钥库。':'账户信息已填入。解锁对应密钥库后开始核验。';
  location.hash='accountBinding';
});
el('accountKeyForm').addEventListener('submit',async event=>{
  event.preventDefault();if(busy||!vault?.unlocked)return;
  busy=true;checkingKeys=true;vault.cancelAccountCheck();
  el('accountKeyProgressBox').hidden=false;el('accountKeyProgress').value=0;el('accountKeyPercent').textContent='0%';
  el('accountKeyStatus').textContent='读取账户并重建对应密钥树，完成后会再次核对链上状态。';render();
  try{
    const result=await vault.checkAccountKeys({account:el('accountKeyAddress').value,endpoint:el('accountKeyRpc').value.trim()},value=>{
      el('accountKeyProgress').value=Math.round(value*1024);el('accountKeyPercent').textContent=Math.round(value*100)+'%';
    });
    el('accountKeyStatus').textContent=result.matched?'密钥根与核验区块中的账户状态一致。此结果不启用交易签名。':
      '当前密钥库未能重建该账户的密钥根。请检查账户、网络和密钥库。';
  }catch(error){el('accountKeyStatus').textContent=errors[error.code]??'核验未完成，请检查账户地址、RPC 网络和连接后重试。';}
  finally{checkingKeys=false;busy=false;el('accountKeyProgressBox').hidden=true;render();}
});
el('accountKeyCancel').addEventListener('click',()=>vault?.cancelAccountCheck());
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
  vault=new TestVault(await openVaultStore(),{onLock:reason=>{
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
