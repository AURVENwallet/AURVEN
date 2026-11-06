// Served only by the loopback launcher, alongside the normal wallet page.
import {checkSandboxAccount} from '/vault-ui.js';

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
