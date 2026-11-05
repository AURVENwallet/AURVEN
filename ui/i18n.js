import {translateText,normalizeLanguage} from './i18n-copy.js';

const storageKey='aurven.language';
let language='zh-CN';
try { language=normalizeLanguage(localStorage.getItem(storageKey)); } catch { /* Storage is optional. */ }
const originals=new WeakMap();
const attributes=['aria-label','aria-valuetext','title','placeholder','alt'];
const excluded='script,style,code,pre,textarea,[data-i18n-ignore]';

// Keep the source and last rendered value per DOM field. When application code
// updates a live status, it becomes the new source, so switching never restores
// stale balances, messages or simulation state. Form values are never written.
function renderValue(node,key,current,write){
  let record=originals.get(node);
  if(!record){record=new Map();originals.set(node,record);}
  let entry=record.get(key);
  if(!entry || current!==entry.rendered) entry={source:current,rendered:current};
  const value=translateText(entry.source,language);
  entry.rendered=value;record.set(key,entry);
  if(value!==current)write(value);
}
function translateNode(node){
  if(node.nodeType===Node.TEXT_NODE){
    if(!node.parentElement || node.parentElement.closest(excluded))return;
    renderValue(node,'text',node.data,value=>{node.data=value;});return;
  }
  if(node.nodeType!==Node.ELEMENT_NODE && node.nodeType!==Node.DOCUMENT_NODE)return;
  if(node.nodeType===Node.ELEMENT_NODE){
    if(node.matches(excluded) || node.closest('[data-i18n-ignore]'))return;
    for(const name of attributes){
      if(node.hasAttribute(name))renderValue(node,name,node.getAttribute(name),value=>node.setAttribute(name,value));
    }
    if(node.matches('meta[name="description"]'))renderValue(node,'content',node.content,value=>{node.content=value;});
  }
  for(const child of node.childNodes)translateNode(child);
}
const controls=document.querySelector('.language-switch');
function selectLanguage(value,persist=true){
  language=normalizeLanguage(value);
  document.documentElement.lang=language;
  if(persist){try{localStorage.setItem(storageKey,language);}catch{/* Switch still works without storage. */}}
  translateNode(document);
  controls?.querySelectorAll('[data-language]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.language===language)));
  controls?.setAttribute('aria-label',language==='en'?'Select language':'选择语言');
}
controls?.querySelectorAll('[data-language]').forEach(button=>button.addEventListener('click',()=>selectLanguage(button.dataset.language)));
// Translate only newly changed text or labeled elements, not the 3D animation.
const observer=new MutationObserver(records=>{
  for(const record of records){
    if(record.type==='childList')record.addedNodes.forEach(translateNode);
    else if(record.type==='attributes'){
      const node=record.target,name=record.attributeName;
      if(!node.closest(excluded) && node.hasAttribute(name))renderValue(node,name,node.getAttribute(name),value=>node.setAttribute(name,value));
    }else translateNode(record.target);
  }
});
selectLanguage(language,false);
observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:[...attributes,'content']});
window.addEventListener('storage',event=>{if(event.key===storageKey || event.key===null)selectLanguage(event.newValue,false);});
window.addEventListener('pageshow',()=>{
  try{selectLanguage(localStorage.getItem(storageKey),false);}catch{selectLanguage(language,false);}
});
