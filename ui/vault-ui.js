import {openVaultStore} from './vault-store.js';
import {TestVault} from './vault-service.js';
import {MAX_BACKUP_BYTES} from './vault-crypto.js';
const el=id=>document.getElementById(id);
const status=el('vaultStatus');
let vault,busy=false,details;
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
  FULL:'一次性密钥记录已达到本版本上限，已停止操作。'
};
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
}
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
  });
});
el('vaultUnlockForm').addEventListener('submit',event=>{
  event.preventDefault();
  run(async()=>{
    details=await vault.unlock(el('vaultPassword').value);
    status.textContent=details.mode==='recovery-readonly'?'备份已解锁，仅供查看。签名保持禁用。':'密钥库已解锁，两分钟无操作后自动锁定。';
  });
});
el('vaultRestoreForm').addEventListener('submit',event=>{
  event.preventDefault();
  run(async()=>{
    const file=el('vaultFile').files[0];
    if(!file||file.size>MAX_BACKUP_BYTES){const error=new Error();error.code='FORMAT';throw error;}
    details=await vault.restoreBackup(await file.text(),el('vaultBackupPassword').value);
    status.textContent='备份已恢复为只读密钥库。旧备份不能证明一次性密钥从未被使用，签名保持禁用。';
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
for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>vault?.touch(),{passive:true});
document.addEventListener('visibilitychange',()=>{if(document.hidden)vault?.lock('hidden');});
window.addEventListener('pagehide',()=>vault?.lock('hidden'));
window.addEventListener('pageshow',()=>{vault?.lock('navigation');render();});
try{
  if(!isSecureContext||!crypto.subtle||!navigator.locks)throw {code:'UNSUPPORTED'};
  vault=new TestVault(await openVaultStore(),{onLock:reason=>{
    status.textContent=reason==='manual'?'密钥库已锁定。':'密钥库已自动锁定，请重新输入密码。';render();
  }});
  details=await vault.inspect();
  status.textContent=details?'本地密钥库已就绪，输入密码解锁。':'创建新的测试密钥，或恢复已有的加密测试备份。';
}catch(error){vault=undefined;status.textContent=errors[error.code]??errors.STORAGE;}
render();
