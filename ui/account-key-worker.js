import {deriveAccountRoot} from './account-key-engine.js';
let busy=false;
self.onmessage=async({data})=>{
  const {id,type,payload}=data??{};
  if(!Number.isSafeInteger(id)||id<1)return;
  if(busy){self.postMessage({id,error:'BUSY'});return;}
  if(type!=='check'){self.postMessage({id,error:'KEY_CONTEXT'});return;}
  busy=true;
  try{self.postMessage({id,result:await deriveAccountRoot(payload,progress=>self.postMessage({id,progress}))});}
  catch(error){self.postMessage({id,error:error.code??'WORKER'});}
  finally{busy=false;}
};
