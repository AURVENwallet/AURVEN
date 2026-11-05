const oldRoutes={'#flow':'./flow.html','#lab':'./lab.html','#wallet':'./wallet.html'};
if(oldRoutes[location.hash])location.replace(oldRoutes[location.hash]);
const get=id=>document.getElementById(id);
let scene,open=true;
function toggle(){open=!open;get('heroExplode').innerHTML=open?'合上金库 <span>↙</span>':'拆开金库 <span>↗</span>';get('heroExplode').setAttribute('aria-pressed',String(open));scene?.explode(open);}
get('heroExplode').onclick=toggle;
get('heroReset').onclick=()=>scene?.reset();
try{
  const {createVaultScene}=await import('./vault-scene.js');
  scene=createVaultScene({canvas:get('heroCanvas'),kind:'hero',onSelect:toggle});
}catch(error){
  get('heroVisual').dataset.unavailable='true';
  get('heroHint').textContent='当前显示静态预览 · 可继续探索功能页面';
  get('heroExplode').disabled=true;get('heroReset').disabled=true;
  console.warn('3D preview unavailable',error);
}
