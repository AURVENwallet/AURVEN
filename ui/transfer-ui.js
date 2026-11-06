import {prepareTransfer} from './transfer.js';
import {readAccount} from './account-state.js';
import {localSimulationEndpoint} from './local-transfer.js';
import {trackAccount} from './activity-ui.js';
import {fetchDemoReport,verifyLocalDemo,LOCAL_DEMO_RPC,DEMO_STAGES} from './local-demo.js';

const get = id => document.getElementById(id);
const form = get('transferForm');
const field = name => form.elements.namedItem(name);
let draft;
let controller;
let version = 0;
let confirmedAccount;
let verifiedDemo;
let demoLoading=false;
let trackingState;
let draftActions;
let reviewReport;
let reservedReceipt;
let reserving = false;
let reviewController;

function clearReview() {
  reviewController?.abort();
  reviewController = undefined;
  reviewReport = undefined;
  reservedReceipt = undefined;
  get('simulatePanel').hidden = true;
  const interrupted = reserving;
  if (interrupted) {
    reserving = false;
    draft = undefined;
    get('exportTransfer').disabled = true;
  }
  get('reservePanel').hidden = true;
  get('reviewBlock').textContent = '';
  get('reviewStatus').textContent = interrupted ? '预留结果待核对，请解锁后重新生成草稿。' :
    draft?.leafReserved ? '叶号已为此摘要永久预留。可导出未签名草稿。' : '';
  get('reviewDraft').disabled = !(draftActions && draft?.stateSource === 'rpc-snapshot' && !draft.leafReserved);
}

export function connectDraftReview(actions) {
  draftActions = actions;
  clearReview();
  document.addEventListener('aurven:key-check-cleared',clearReview);
}

async function checkOrReserve(reserve) {
  if (!draft || draft.leafReserved || !draftActions || reviewController || (reserve && !reviewReport)) return;
  const request = new AbortController();
  reviewController = request;
  const previous = reviewReport;
  reviewReport = undefined;
  reserving = reserve;
  get('reservePanel').hidden = true;
  get('exportTransfer').disabled = reserve;
  get('reviewDraft').disabled = true;
  get('reviewBlock').textContent = '';
  get('reviewStatus').textContent = reserve ? '正在重新核对并保存叶号…' : '正在复核草稿和密钥使用记录…';
  try {
    const endpoint = field('rpc').value.trim();
    const result = reserve
      ? await draftActions.reserve(draft,endpoint,previous,request.signal)
      : await draftActions.review(draft,endpoint,request.signal);
    if (request.signal.aborted) return;
    if (reserve) {
      draft = {...draft,leafReserved:true};
      if (localSimulationEndpoint(endpoint,draft.chainId)) {
        reservedReceipt = result;
        get('simulatePanel').hidden = false;
      }
      get('reviewStatus').textContent = '叶号已为此摘要永久预留。可导出未签名草稿。';
    } else {
      reviewReport = result;
      get('reservePanel').hidden = false;
      get('reviewStatus').textContent = '草稿在此区块通过复核，叶号尚未预留。';
    }
    get('reviewBlock').textContent = ' #' + BigInt(result.blockNumber);
  } catch (error) {
    if (!request.signal.aborted) {
      if (reserve) draft = undefined;
      get('reviewStatus').textContent = error.message;
    }
  } finally {
    if (reviewController === request) {
      reviewController = undefined;
      reserving = false;
      get('reviewDraft').disabled = !draft || draft.leafReserved;
      get('exportTransfer').disabled = !draft;
    }
  }
}
get('reviewDraft').onclick = () => checkOrReserve(false);
get('reserveDraft').onclick = () => checkOrReserve(true);
get('simulateDraft').onclick = async () => {
  if (!reservedReceipt || reviewController) return;
  const receipt = reservedReceipt;
  reservedReceipt = undefined;
  const request = new AbortController();
  reviewController = request;
  get('simulatePanel').hidden = true;
  get('reviewBlock').textContent = '';
  get('reviewStatus').textContent = '正在本地生成签名并模拟合约执行…';
  try {
    const result = await draftActions.simulate(receipt,request.signal);
    if (!request.signal.aborted) {
      get('reviewStatus').textContent = '合约已在此区块接受签名并完成模拟。模拟未发送交易。';
      get('reviewBlock').textContent = ' #' + BigInt(result.blockNumber);
    }
  } catch (error) {
    if (!request.signal.aborted) get('reviewStatus').textContent = error.message;
  } finally {
    if (reviewController === request) reviewController = undefined;
  }
};

// A public host has no access to the visitor's locally generated demo record.
// Keep the complete signed-demo flow on the visitor's own loopback preview.
if (!['localhost','127.0.0.1','[::1]'].includes(location.hostname)) {
  get('loadDemo').hidden=true;
  const guide=document.createElement('a');
  guide.href='https://github.com/AURVENwallet/AURVEN#quick-start';
  guide.className='button run';guide.textContent='本地运行指南 ↗';
  get('loadDemo').after(guide);
  get('demoStatus').textContent='完整签名演示需在自己的电脑运行。请按指南启动本地网页和 Anvil；下方仍可准备离线草稿或读取 BSC 测试账户。';
}

function invalidate() {
  trackingState=undefined;get('trackAccount').disabled=true;get('checkAccountKeys').disabled=true;
  version += 1;
  controller?.abort();
  if(demoLoading){demoLoading=false;get('demoStatus').textContent='载入已取消，可重新载入演示账户。';}
  draft = undefined;
  clearReview();
  get('exportTransfer').disabled = true;
  get('transferResult').textContent = '交易信息已修改，请重新生成摘要。';
  get('accountStatus').textContent = '账户状态待同步';
  get('accountDetails').hidden = true;
  get('syncAccount').disabled = false;
  get('prepare').disabled = false;
  get('loadDemo').disabled = false;
  if (confirmedAccount && (field('account').value.trim().toLowerCase() !== confirmedAccount.account.toLowerCase() ||
      Number(field('chain').value) !== confirmedAccount.chainId || field('rpc').value.trim() !== confirmedAccount.endpoint)) {
    confirmedAccount=undefined;
    get('copyAccount').disabled=true;
    verifiedDemo=undefined;
    get('demoResults').hidden=true;
    get('demoStatus').textContent='账户信息已修改，可重新载入演示账户。';
  }
}
form.addEventListener('input', invalidate);
function updateSourceFields() {
  const synced = field('source').value === 'chain';
  field('epoch').readOnly = synced;
  field('leaf').readOnly = synced;
}
field('source').addEventListener('change', updateSourceFields);
form.addEventListener('input', updateSourceFields);
form.addEventListener('focusin', updateSourceFields);
updateSourceFields();
window.addEventListener('pageshow', event => {
  // History navigation can restore select values after the module initializes.
  updateSourceFields();
  requestAnimationFrame(updateSourceFields);
  if (event.persisted) invalidate();
});

function formatBalance(wei) {
  const value = BigInt(wei);
  const whole = value / 10n ** 18n;
  const fraction = (value % (10n ** 18n)).toString().padStart(18, '0').replace(/0+$/, '');
  return whole + (fraction ? '.' + fraction : '');
}

function showAccount(state) {
  trackingState=state;get('trackAccount').disabled=false;get('checkAccountKeys').disabled=false;
  field('epoch').value=state.epoch;field('leaf').value=state.next;
  confirmedAccount={account:state.account,chainId:state.chainId,endpoint:field('rpc').value.trim()};
  get('copyAccount').disabled=false;
  get('accountStatus').textContent=state.epoch===0?'账户已部署 · 需要首次换根':
    state.next>=960?'日常交易叶已用尽 · 需要换根':'账户状态已同步 · 可以生成草稿';
  get('accountDetails').hidden=false;
  get('accountBalance').textContent=formatBalance(state.balanceWei)+' 测试币';
  get('accountBlock').textContent=BigInt(state.blockNumber).toString();
  get('accountLeaves').textContent=Math.max(0,960-state.next)+' / 960';
  get('accountRoot').textContent=state.root;
}

async function syncAccount() {
  controller?.abort();
  controller = new AbortController();
  const requestVersion = version;
  get('accountStatus').textContent = '正在读取同一区块的账户状态…';
  get('syncAccount').disabled = true;
  try {
    const state = await readAccount({
      endpoint: field('rpc').value.trim(), account: field('account').value.trim(),
      chainId: Number(field('chain').value), signal: controller.signal
    });
    if (requestVersion !== version) return;
    showAccount(state);
    return state;
  } catch (error) {
    if (requestVersion !== version) return;
    get('accountDetails').hidden = true;
    confirmedAccount=undefined;get('copyAccount').disabled=true;
    get('accountStatus').textContent = '同步失败 · ' + error.message;
    throw error;
  } finally {
    if (requestVersion === version) get('syncAccount').disabled = false;
  }
}

get('syncAccount').onclick = async () => {
  invalidate();
  field('source').value = 'chain';
  field('epoch').readOnly = true;
  field('leaf').readOnly = true;
  try { await syncAccount(); } catch { /* Error is displayed next to the account. */ }
};

form.onsubmit = async event => {
  event.preventDefault();
  invalidate();
  draft = undefined;
  get('exportTransfer').disabled = true;
  get('prepare').disabled = true;
  const requestVersion = version;
  try {
    const state = field('source').value === 'chain' ? await syncAccount() : undefined;
    if (requestVersion !== version) return;
    if (field('source').value === 'chain' && !state?.ready) {
      throw new Error('请先完成换根，再准备交易');
    }
    const selectedLeaf = state && draftActions ? await draftActions.nextLeaf(state) : Number(field('leaf').value);
    if (requestVersion !== version) return;
    field('leaf').value = selectedLeaf;
    const transaction = prepareTransfer({
      account: field('account').value.trim(), recipient: field('recipient').value.trim(),
      amount: field('amount').value.trim(), chainId: Number(field('chain').value),
      epoch: state?.epoch ?? Number(field('epoch').value),
      leaf: selectedLeaf,
      deadline: (state?.timestamp ?? Math.floor(Date.now() / 1000)) + 600,
      randomizer: crypto.getRandomValues(new Uint8Array(16))
    });
    draft = {
      format: 'bsc-key-lab-unsigned-transfer-v2',
      stateSource: state ? 'rpc-snapshot' : 'manual-offline',
      ...transaction,
      snapshot: state ?? null,
      leafReserved: false
    };
    get('transferResult').textContent = [
      '网络　' + (transaction.chainId === 97 ? 'BSC Testnet' : 'Anvil 本地链'),
      '收款人　' + transaction.recipient,
      '金额　' + formatBalance(transaction.valueWei) + ' 测试币',
      '叶号　' + transaction.leaf + '　代数　' + transaction.epoch,
      '截止时间　' + new Date(transaction.deadline * 1000).toLocaleString(),
      '签名摘要　' + transaction.digest,
      state ? '已按链上快照生成未签名草稿。' : '离线草稿使用手动状态，签名前须同步账户。'
    ].join('\n\n');
    get('exportTransfer').disabled = false;
    clearReview();
  } catch (error) {
    if (requestVersion === version) get('transferResult').textContent = error.message;
  } finally {
    if (requestVersion === version) get('prepare').disabled = false;
  }
};

get('exportTransfer').onclick = () => {
  if (!draft) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'aurven-unsigned-transfer.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

get('copyAccount').onclick=async()=>{
  if(!confirmedAccount)return;
  try{
    await navigator.clipboard.writeText(confirmedAccount.account);
    get('accountStatus').textContent='账户地址已复制 · '+confirmedAccount.account;
  }catch{get('accountStatus').textContent='浏览器未允许复制，请从账户地址栏手动复制。';}
};

get('trackAccount').onclick=async()=>{
  if(!trackingState)return;
  try{await trackAccount(trackingState,field('rpc').value.trim());}
  catch{get('accountStatus').textContent='本地记录存储不可用或已达到上限。';}
};
get('checkAccountKeys').onclick=()=>{
  if(!trackingState)return;
  document.dispatchEvent(new CustomEvent('aurven:check-account-keys',{detail:{account:trackingState.account,
    chainId:trackingState.chainId,endpoint:field('rpc').value.trim()}}));
};
document.addEventListener('aurven:watch-account',event=>{
  invalidate();confirmedAccount=undefined;verifiedDemo=undefined;
  get('copyAccount').disabled=true;get('demoResults').hidden=true;
  field('account').value=event.detail.account;field('chain').value=event.detail.chainId;
  field('rpc').value=event.detail.endpoint;field('source').value='chain';updateSourceFields();
  get('accountStatus').textContent='只读账户已填入，请重新同步链上状态。';
});

function showDemo(result){
  verifiedDemo=result;
  const {state,receipts}=result;
  get('demoBalance').textContent=formatBalance(state.balanceWei);
  get('demoEpoch').textContent=state.epoch;
  get('demoLeaves').textContent=Math.max(0,960-state.next);
  get('demoAddress').textContent=state.account;
  get('demoFee').textContent=formatBalance(receipts.reduce((sum,row)=>sum+BigInt(row.feeWei),0n))+' 本地测试币';
  get('demoReceipts').replaceChildren(...receipts.map((row,i)=>{
    const li=document.createElement('li');
    const number=document.createElement('span');number.className='receipt-number';number.textContent=String(i+1).padStart(2,'0');
    const body=document.createElement('div');
    const title=document.createElement('strong');title.textContent=DEMO_STAGES[i][1];
    const details=document.createElement('small');details.textContent='区块 '+BigInt(row.blockNumber)+' · Gas '+row.gasUsed+' · 费用 '+formatBalance(row.feeWei);
    const hash=document.createElement('code');hash.textContent=row.hash;
    const status=document.createElement('span');status.className='receipt-status';status.textContent='已确认';
    body.append(title,details,hash);li.append(number,body,status);return li;
  }));
  get('demoResults').hidden=false;
  get('demoStatus').textContent='已同步余额，并核对 6 笔交易的成功回执与所在区块。';
}
get('loadDemo').onclick=async()=>{
  invalidate();
  confirmedAccount=undefined;verifiedDemo=undefined;
  get('copyAccount').disabled=true;get('demoResults').hidden=true;
  get('loadDemo').disabled=true;get('demoStatus').textContent='正在连接本地测试链，核对账户与交易回执…';
  demoLoading=true;
  controller=new AbortController();const current=version;
  try{
    const report=await fetchDemoReport(controller.signal);
    const result=await verifyLocalDemo(report,controller.signal);
    if(current!==version)return;
    field('chain').value='31337';field('account').value=report.account;field('source').value='chain';
    field('rpc').value=LOCAL_DEMO_RPC;field('recipient').value=report.recipient;field('amount').value='0.01';
    updateSourceFields();showAccount(result.state);showDemo(result);
    get('transferResult').textContent='演示账户已载入。可核对信息并生成新的待签名草稿。';
  }catch(error){
    if(current===version)get('demoStatus').textContent='载入失败 · '+(error instanceof TypeError?'请确认本机 Anvil 测试链正在运行。':error.message);
  }finally{if(current===version){demoLoading=false;get('loadDemo').disabled=false;}}
};
get('exportDemo').onclick=()=>{
  if(!verifiedDemo)return;
  const url=URL.createObjectURL(new Blob([JSON.stringify(verifiedDemo,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='aurven-local-demo-receipts.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
};

get('trackDemo').onclick=async()=>{
  if(!verifiedDemo)return;
  try{await trackAccount(verifiedDemo.state,LOCAL_DEMO_RPC,verifiedDemo.receipts.map(row=>row.hash));}
  catch{get('demoStatus').textContent='本地记录存储不可用或已达到上限。';}
};


