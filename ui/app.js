import {verify} from './verify.js';
import sample from './vector.js';
const get=id=>document.getElementById(id);
const canvas=get('scene');
const hex=value=>Array.from(value,b=>b.toString(16).padStart(2,'0')).join('');
function levels(tamper){const path=[];verify(tamper,value=>path.push(hex(value)));return path;}
const baseline=levels(false);
let selected=baseline,scene,exploded=false,rotating=false,validated=false,playback;
get('expectedRoot').textContent=sample.root;
function stopPlayback(){clearInterval(playback);playback=undefined;get('play').textContent='播放验证路径';}
function showLevel(){
  const index=Number(get('level').value);
  get('levelName').textContent=index===0?'叶节点 · 哈希链端点压缩值':index===10?'第 10 层 · 最终根':'第 '+index+' 层 · 路径节点';
  get('original').textContent=baseline[index];get('current').replaceChildren();
  for(let i=0;i<32;i+=2){const byte=selected[index].slice(i,i+2);const el=document.createElement(byte===baseline[index].slice(i,i+2)?'span':'mark');el.textContent=byte;get('current').append(el);}
  document.querySelectorAll('#nodes button').forEach((b,i)=>b.setAttribute('aria-pressed',String(i===index)));
  scene?.setProof(index,validated?selected[index]===baseline[index]:null);
}
get('level').oninput=()=>{stopPlayback();showLevel();};
get('mode').onchange=()=>{stopPlayback();validated=false;selected=baseline;get('result').textContent='等待验证';delete get('result').dataset.valid;get('trace').hidden=true;delete canvas.parentElement.dataset.status;showLevel();};
get('run').onclick=()=>{
  stopPlayback();selected=levels(get('mode').selectedIndex===1);validated=true;
  const valid=selected[10]===sample.root;
  canvas.parentElement.dataset.status=valid?'good':'bad';get('result').dataset.valid=String(valid);
  get('result').textContent=valid?'验证通过 · 重建根与参考根一致':'验证拒绝 · 红色标出不同的字节';
  get('trace').hidden=false;get('level').value=10;showLevel();
};
get('explode').onclick=()=>{exploded=!exploded;get('explode').textContent=exploded?'收起路径':'展开路径';get('explode').setAttribute('aria-pressed',String(exploded));scene?.explode(exploded);};
get('zoom').oninput=()=>scene?.setZoom(Number(get('zoom').value)/100);
get('view').onclick=()=>canvas.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
get('reset').onclick=()=>{scene?.reset();get('zoom').value=100;exploded=false;scene?.explode(false);get('explode').textContent='展开路径';get('explode').setAttribute('aria-pressed','false');};
function stoppedRotation(){rotating=false;get('motion').textContent='自动旋转';get('motion').setAttribute('aria-pressed','false');}
get('motion').onclick=()=>{rotating=scene?.autoRotate(!rotating)??false;get('motion').textContent=rotating?'暂停旋转':'自动旋转';get('motion').setAttribute('aria-pressed',String(rotating));};
for(let i=0;i<=10;i++){const b=document.createElement('button');b.textContent=String(i).padStart(2,'0');b.setAttribute('aria-label',i===0?'叶节点':'第 '+i+' 层');b.onclick=()=>{stopPlayback();get('level').value=i;showLevel();};get('nodes').append(b);}
get('play').onclick=()=>{
  if(playback){stopPlayback();return;}
  if(matchMedia('(prefers-reduced-motion: reduce)').matches){get('level').value=(Number(get('level').value)+1)%11;showLevel();return;}
  get('level').value=0;showLevel();get('play').textContent='暂停播放';
  playback=setInterval(()=>{const next=Number(get('level').value)+1;if(next>10){stopPlayback();return;}get('level').value=next;showLevel();},700);
};
get('export').onclick=()=>{
  const report={format:'bsc-key-lab-proof-inspection-v1',protocol:'keylab/evm/v1',network:'local fixture / 31337',sample:get('mode').selectedIndex===1?'modified-first-byte':'original',expectedRoot:sample.root,computedRoot:selected[10],accepted:selected[10]===sample.root,levels:selected.map((hash,level)=>({level,hash,reference:baseline[level]}))};
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='bsc-key-lab-proof-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopPlayback();stoppedRotation();}});
window.addEventListener('pagehide',stopPlayback);
showLevel();
try{
  const {createVaultScene}=await import('./vault-scene.js');
  scene=createVaultScene({canvas,kind:'proof',onSelect:id=>{stopPlayback();get('level').value=Number(id);showLevel();},onAutoStop:stoppedRotation});showLevel();
}catch(error){
  canvas.parentElement.dataset.unavailable='true';
  canvas.parentElement.querySelector('footer span').textContent='静态预览 · 证明计算仍可运行';
  for(const id of ['explode','view','reset','motion','zoom'])get(id).disabled=true;
  console.warn('3D preview unavailable',error);
}
