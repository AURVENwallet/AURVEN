import {projectFlow} from './flow-state.js?v=3';
import {FLOW_NODES,connectionsFor} from './flow-topology.js?v=3';
const get=id=>document.getElementById(id);
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
const stageCopy=[['先定义，再授权。','签名端生成授权证明，交给 Gas 付款账户提交。'],['先验证，再放行。','付款账户提交交易并支付 Gas，BSC 运行账户合约核对证明。'],['授权通过，资金出发。','网络继续执行智能账户的转账调用，本金从账户流向收款端。'],['结果清晰可见。','本金已到达收款端，网络向付款账户返回执行回执。']];
let scene,progress=0,playing=false,exploded=false,raf=0,last=0;
function state(){return projectFlow({progress,mode:get('flowMode').value,amount:Number(get('flowAmount').value)});}
function update(){
  const s=state();progress=s.progress;
  get('flowProgress').value=Math.round(progress*1000);
  get('flowAmountLabel').textContent=(s.amountCents/100).toFixed(2)+' BNB';
  get('flowSenderBalance').textContent=(s.accountCents/100).toFixed(2);
  get('flowReceiverBalance').textContent=(s.recipientCents/100).toFixed(2);
  get('flowFeeBalance').textContent=(s.payerUnits/10000).toFixed(4);
  const title=s.rejected?'验证失败，本金留存。':stageCopy[s.stage][0];
  get('stageLabel').textContent=String(s.stage+1).padStart(2,'0')+' / '+s.stageName;
  get('stageTitle').textContent=title;
  get('stageDescription').textContent=s.rejected?'证明未通过，转账不会执行。此处模拟已上链回滚，仍扣除演示手续费。':stageCopy[s.stage][1];
  get('proofState').textContent=s.proof;get('assetState').textContent=s.assets;
  get('networkState').textContent=s.network;
  const status=s.rejected?'验证拒绝 · 本金未转移':s.stageName===s.assets?s.assets:s.stageName+' · '+s.assets;
  if(get('flowStatus').textContent!==status)get('flowStatus').textContent=status;
  get('main').dataset.rejected=String(s.rejected);
  document.querySelectorAll('[data-stage]').forEach((b,i)=>b.setAttribute('aria-pressed',String(i===s.stage)));
  scene?.setFlow(s);
}
function stop(){playing=false;cancelAnimationFrame(raf);raf=0;get('flowPlay').textContent=reduce.matches?'→':'▶';get('flowPlay').setAttribute('aria-label',reduce.matches?'逐步推进':'播放流程');}
function seek(value,focus=false){stop();progress=value;update();if(focus){const s=state();selectNode(['signer','account','recipient','recipient'][s.stage]);}}
function tick(time){
  if(!playing)return;
  if(last)progress+=Math.min(time-last,60)/14000*Number(get('flowSpeed').value);
  last=time;update();
  if(progress>=1||(get('flowMode').value==='reject'&&progress>=.5)){stop();return;}
  raf=requestAnimationFrame(tick);
}
function selectNode(id,focus=true){
  if(!FLOW_NODES[id])return;
  get('nodeTitle').textContent=FLOW_NODES[id].label;get('nodeDetail').textContent=FLOW_NODES[id].detail;
  const links=connectionsFor(id),related=new Set(links.flatMap(link=>[link.from,link.to]));
  get('nodeConnections').replaceChildren(...links.map(link=>{
    const li=document.createElement('li');li.dataset.kind=link.kind;
    const direction=document.createElement('span');direction.textContent=FLOW_NODES[link.from].label+' → '+FLOW_NODES[link.to].label;
    const label=document.createElement('small');label.textContent=link.label;li.append(direction,label);return li;
  }));
  document.querySelectorAll('[data-flow-node]').forEach(b=>{b.setAttribute('aria-pressed',String(b.dataset.flowNode===id));b.dataset.related=String(related.has(b.dataset.flowNode));});
  scene?.selectConnections(id);if(focus)scene?.focus(id);
}
get('flowPlay').onclick=()=>{
  if(reduce.matches){const next=[.0,.32,.70,1].find(p=>p>progress+.01);seek(next??0,true);return;}
  if(playing){stop();return;}
  if(progress>=1||(get('flowMode').value==='reject'&&progress>=.5))progress=0;
  playing=true;last=0;get('flowPlay').textContent='Ⅱ';get('flowPlay').setAttribute('aria-label','暂停流程');raf=requestAnimationFrame(tick);
};
get('flowProgress').oninput=()=>seek(Number(get('flowProgress').value)/1000);
get('flowReset').onclick=()=>{seek(0);scene?.reset();};
get('flowView').onclick=()=>scene?.reset();
get('zoomIn').onclick=()=>scene?.zoomBy(1.1);get('zoomOut').onclick=()=>scene?.zoomBy(.9);
get('flowExplode').onclick=()=>{exploded=!exploded;scene?.explode(exploded);get('flowExplode').innerHTML=exploded?'合上账户 <span>↙</span>':'拆开账户 <span>↗</span>';get('flowExplode').setAttribute('aria-pressed',String(exploded));};
for(const id of ['flowAmount','flowMode'])get(id).addEventListener('input',()=>seek(0));
document.querySelectorAll('[data-stage]').forEach(b=>b.onclick=()=>seek(Number(b.dataset.stage),true));
document.querySelectorAll('[data-flow-node]').forEach(b=>b.onclick=()=>selectNode(b.dataset.flowNode));
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
window.addEventListener('pagehide',stop);
reduce.addEventListener('change',()=>{stop();get('flowHint').textContent=reduce.matches?'减少动态效果 · 使用步骤按钮查看':'↔ 拖动旋转 · 滚轮缩放';});
stop();update();selectNode('account',false);
try{
  const {createVaultScene}=await import('./vault-scene.js?v=6');
  scene=createVaultScene({canvas:get('flowCanvas'),kind:'flow',onSelect:selectNode});update();
}catch(error){
  get('flowStage').dataset.unavailable='true';get('flowHint').textContent='当前显示静态预览 · 步骤与模拟结果仍可查看';
  for(const id of ['flowExplode','flowView','zoomIn','zoomOut'])get(id).disabled=true;
  console.warn('3D preview unavailable',error);
}
