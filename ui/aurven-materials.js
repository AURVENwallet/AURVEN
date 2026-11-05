// A pointer-controlled reflection. No animation loop runs while the pointer is idle.
const interactive='button:not(:disabled),a.button';
const finePointer=matchMedia('(hover:hover) and (pointer:fine)');
const reducedMotion=matchMedia('(prefers-reduced-motion:reduce)');
let frame=0,pending;
function drawReflection(){
  frame=0;
  if(!pending||!pending.target.isConnected||pending.target.matches(':disabled'))return;
  const {target,x,y}=pending,rect=target.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  target.style.setProperty('--light-x',Math.max(0,Math.min(100,(x-rect.left)/rect.width*100))+'%');
  target.style.setProperty('--light-y',Math.max(0,Math.min(100,(y-rect.top)/rect.height*100))+'%');
}
document.addEventListener('pointermove',event=>{
  if(!finePointer.matches||reducedMotion.matches)return;
  const target=event.target instanceof Element?event.target.closest(interactive):null;
  if(!target)return;
  pending={target,x:event.clientX,y:event.clientY};
  if(!frame)frame=requestAnimationFrame(drawReflection);
},{passive:true});
document.addEventListener('pointerout',event=>{
  const target=event.target instanceof Element?event.target.closest(interactive):null;
  if(!target||(event.relatedTarget instanceof Node&&target.contains(event.relatedTarget)))return;
  target.style.removeProperty('--light-x');target.style.removeProperty('--light-y');
  if(pending?.target===target){cancelAnimationFrame(frame);frame=0;pending=null;}
},{passive:true});
window.addEventListener('pagehide',()=>{cancelAnimationFrame(frame);frame=0;pending=null;});
